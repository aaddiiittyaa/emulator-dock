import type * as grpc from '@grpc/grpc-js';
import type { RunningEmulator } from './discovery';
import { EmulatorClient, GrpcStatus, ImageMessage, SkinRotation } from './emulatorClient';

export interface Frame {
  width: number;
  height: number;
  rotation: SkinRotation;
  seq: number;
  /** Tightly packed RGB888 pixels, row-major. */
  data: Uint8Array;
}

export interface SessionSink {
  frame(frame: Frame): void;
  screenOff(): void;
  log(message: string): void;
}

export interface TouchPoint {
  id: number;
  nx: number;
  ny: number;
  /** 0 releases the contact. */
  pressure: number;
}

/**
 * A live connection to one device, as driven by a view controller. Implemented over the
 * emulator's gRPC API (EmulatorSession) and over adb for physical devices (AdbSession).
 * Coordinates are normalized (0..1) on the image as displayed.
 */
export interface DeviceSession {
  readonly displaySize: { width: number; height: number };
  start(): Promise<void>;
  setActive(active: boolean): void;
  setViewport(width: number, height: number): void;
  resync(): void;
  frameAck(): void;
  pointer(nx: number, ny: number, buttons: number, rotation?: SkinRotation): void;
  touch(points: TouchPoint[], rotation?: SkinRotation): void;
  wheel(dx: number, dy: number): void;
  key(key: string, eventType?: 'keydown' | 'keyup' | 'keypress'): void;
  text(text: string): void;
  ctrlCombo(letter: string): void;
  paste(text: string): Promise<void>;
  copyFromDevice(cut: boolean): Promise<string>;
  rotate(direction: 1 | -1): Promise<void>;
  screenshotPng(): Promise<Buffer>;
  dispose(): void;
}

const ROTATION_QUADRANT: Record<SkinRotation, number> = {
  PORTRAIT: 0,
  LANDSCAPE: 1,
  REVERSE_PORTRAIT: 2,
  REVERSE_LANDSCAPE: 3,
};
const QUADRANT_ANGLE = [0, 90, 180, -90];

/** Frames are sent one at a time; if the webview has not acknowledged a frame after this long, send anyway. */
const ACK_TIMEOUT_MS = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/**
 * A live connection to one emulator: streams its display at the size of the panel and
 * forwards input. Frames use ack-based flow control so the panel always shows the newest
 * frame and latency never builds up when rendering falls behind.
 */
export class EmulatorSession implements DeviceSession {
  readonly client: EmulatorClient;
  private display = { width: 1080, height: 1920 };
  private rotation: SkinRotation = 'PORTRAIT';
  private viewport = { width: 0, height: 0 };
  private active = true;
  private disposed = false;

  private frames?: grpc.ClientReadableStream<ImageMessage>;
  private streamGeneration = 0;
  private retryTimer?: NodeJS.Timeout;
  private inFlightSince = 0;
  private pending?: ImageMessage;
  private screenIsOff = false;

  private input?: grpc.ClientWritableStream<object>;
  private inputMode: 'stream' | 'unary' = 'stream';

  constructor(readonly emulator: RunningEmulator, protoPath: string, private readonly sink: SessionSink) {
    this.client = new EmulatorClient(emulator, protoPath);
  }

  get displaySize() {
    return { ...this.display };
  }

  /** Connects, retrying for a while because a freshly launched emulator may not accept calls yet. */
  async start(timeoutMs = 60000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await this.loadDisplaySize();
        break;
      } catch (e) {
        const err = e as grpc.ServiceError;
        if (this.disposed) {
          return;
        }
        if (err.code === GrpcStatus.UNAUTHENTICATED || err.code === GrpcStatus.PERMISSION_DENIED || Date.now() > deadline) {
          throw err;
        }
        await sleep(1000);
      }
    }
    this.restartFrames();
  }

  private async loadDisplaySize(): Promise<void> {
    try {
      const cfg = await this.client.call('getDisplayConfigurations', {}, 5000);
      const main = (cfg.displays ?? []).find((d: any) => (d.display ?? 0) === 0);
      if (main?.width && main?.height) {
        this.display = { width: main.width, height: main.height };
        return;
      }
    } catch (e) {
      if ((e as grpc.ServiceError).code !== GrpcStatus.UNIMPLEMENTED) {
        throw e;
      }
    }
    // Older emulators: read the LCD size from the hardware configuration.
    const status = await this.client.call('getStatus', {}, 5000);
    const entries: { key: string; value: string }[] = status.hardwareConfig?.entry ?? [];
    const get = (k: string) => Number(entries.find((e) => e.key === k)?.value);
    if (get('hw.lcd.width') && get('hw.lcd.height')) {
      this.display = { width: get('hw.lcd.width'), height: get('hw.lcd.height') };
    }
  }

  setViewport(width: number, height: number): void {
    width = Math.round(width);
    height = Math.round(height);
    if (width === this.viewport.width && height === this.viewport.height) {
      return;
    }
    this.viewport = { width, height };
    this.restartFrames();
  }

  /** Pauses streaming while the panel is hidden. */
  setActive(active: boolean): void {
    if (this.active === active) {
      return;
    }
    this.active = active;
    if (active) {
      this.restartFrames();
    } else {
      this.stopFrames();
    }
  }

  /** Restarts the screen stream so a freshly (re)loaded webview receives the current frame. */
  resync(): void {
    this.restartFrames();
  }

  frameAck(): void {
    this.inFlightSince = 0;
    if (this.pending) {
      this.deliver(this.pending);
    }
  }

  private stopFrames(): void {
    this.streamGeneration++;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.frames?.cancel();
    this.frames = undefined;
    this.pending = undefined;
    this.inFlightSince = 0;
  }

  private restartFrames(): void {
    this.stopFrames();
    if (this.disposed || !this.active || this.viewport.width < 16 || this.viewport.height < 16) {
      return;
    }
    const generation = this.streamGeneration;
    const stream = this.client.streamScreenshot(this.viewport.width, this.viewport.height);
    this.frames = stream;
    stream.on('data', (img: ImageMessage) => {
      if (generation === this.streamGeneration) {
        this.onImage(img);
      }
    });
    stream.on('error', (err: grpc.ServiceError) => {
      if (generation !== this.streamGeneration || err.code === GrpcStatus.CANCELLED) {
        return;
      }
      this.sink.log(`Screen stream error (${err.code}): ${err.details || err.message}`);
      this.scheduleRestart(generation);
    });
    stream.on('end', () => this.scheduleRestart(generation));
  }

  private scheduleRestart(generation: number): void {
    if (generation !== this.streamGeneration || this.disposed || this.retryTimer) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (generation === this.streamGeneration) {
        this.restartFrames();
      }
    }, 1000);
  }

  private onImage(img: ImageMessage): void {
    const { width, height } = img.format;
    if (!width || !height || !img.image?.length) {
      if (!this.screenIsOff) {
        this.screenIsOff = true;
        this.sink.screenOff();
      }
      return;
    }
    this.screenIsOff = false;
    this.rotation = img.format.rotation?.rotation ?? 'PORTRAIT';
    if (this.inFlightSince && Date.now() - this.inFlightSince < ACK_TIMEOUT_MS) {
      this.pending = img;
      return;
    }
    this.deliver(img);
  }

  private deliver(img: ImageMessage): void {
    this.pending = undefined;
    this.inFlightSince = Date.now();
    this.sink.frame({
      width: img.format.width,
      height: img.format.height,
      rotation: img.format.rotation?.rotation ?? 'PORTRAIT',
      seq: img.seq,
      // Copy into a standalone buffer: gRPC buffers can be views into larger pooled memory,
      // and the webview transfer would otherwise send the whole backing store.
      data: new Uint8Array(img.image),
    });
  }

  // ---- Input -------------------------------------------------------------------------

  /** Maps normalized coordinates on the displayed (rotated) image to native display pixels. */
  private toDevice(nx: number, ny: number, rotation: SkinRotation = this.rotation) {
    nx = clamp01(nx);
    ny = clamp01(ny);
    const { width: w, height: h } = this.display;
    let x: number;
    let y: number;
    switch (rotation) {
      case 'LANDSCAPE':
        x = w * (1 - ny);
        y = h * nx;
        break;
      case 'REVERSE_PORTRAIT':
        x = w * (1 - nx);
        y = h * (1 - ny);
        break;
      case 'REVERSE_LANDSCAPE':
        x = w * ny;
        y = h * (1 - nx);
        break;
      default:
        x = w * nx;
        y = h * ny;
    }
    return {
      x: Math.min(w - 1, Math.max(0, Math.round(x))),
      y: Math.min(h - 1, Math.max(0, Math.round(y))),
    };
  }

  private sendInput(event: Record<string, object>): void {
    if (this.disposed) {
      return;
    }
    if (this.inputMode === 'stream') {
      if (!this.input) {
        const stream = this.client.openInputStream((err) => {
          if (this.input === stream) {
            this.input = undefined;
          }
          if (err?.code === GrpcStatus.UNIMPLEMENTED) {
            this.inputMode = 'unary';
            this.sink.log('Emulator does not support streamed input; falling back to individual calls.');
          } else if (err && err.code !== GrpcStatus.CANCELLED) {
            this.sink.log(`Input stream closed (${err.code}): ${err.details || err.message}`);
          }
        });
        stream.on('error', () => {
          /* reported through the completion callback */
        });
        this.input = stream;
      }
      this.input.write(event);
      return;
    }
    const [kind, payload] = Object.entries(event)[0];
    const method = ({ mouse_event: 'sendMouse', touch_event: 'sendTouch', key_event: 'sendKey' } as Record<string, string>)[kind];
    if (method) {
      this.client.call(method, payload).catch((e) => this.sink.log(`${method} failed: ${e.message}`));
    }
  }

  pointer(nx: number, ny: number, buttons: number, rotation?: SkinRotation): void {
    const { x, y } = this.toDevice(nx, ny, rotation);
    this.sendInput({ mouse_event: { x, y, buttons, display: 0 } });
  }

  touch(points: TouchPoint[], rotation?: SkinRotation): void {
    const touches = points.map((p) => ({
      ...this.toDevice(p.nx, p.ny, rotation),
      identifier: p.id,
      pressure: p.pressure,
      touch_major: p.pressure ? 8 : 0,
    }));
    this.sendInput({ touch_event: { touches, display: 0 } });
  }

  wheel(dx: number, dy: number): void {
    this.sendInput({ wheel_event: { dx: Math.round(dx), dy: Math.round(dy), display: 0 } });
  }

  /** Sends a W3C `KeyboardEvent.key` value, e.g. "Enter", "GoBack", "Power". */
  key(key: string, eventType: 'keydown' | 'keyup' | 'keypress' = 'keypress'): void {
    this.sendInput({ key_event: { key, eventType } });
  }

  text(text: string): void {
    if (text) {
      this.sendInput({ key_event: { text } });
    }
  }

  /** Ctrl+<letter> on the device (select all, copy, paste, undo...). */
  ctrlCombo(letter: string): void {
    this.key('Control', 'keydown');
    this.key(letter, 'keypress');
    this.key('Control', 'keyup');
  }

  async paste(text: string): Promise<void> {
    await this.client.call('setClipboard', { text });
    // Give the guest clipboard agent a moment to receive the new contents.
    await sleep(120);
    this.ctrlCombo('v');
  }

  async copyFromDevice(cut: boolean): Promise<string> {
    this.ctrlCombo(cut ? 'x' : 'c');
    await sleep(350);
    const clip = await this.client.call('getClipboard', {});
    return clip.text ?? '';
  }

  async rotate(direction: 1 | -1): Promise<void> {
    const quadrant = (ROTATION_QUADRANT[this.rotation] + (direction === 1 ? 1 : 3)) % 4;
    await this.client.call('setPhysicalModel', {
      target: 'ROTATION',
      value: { data: [0, 0, QUADRANT_ANGLE[quadrant]] },
    });
  }

  async screenshotPng(): Promise<Buffer> {
    const img = await this.client.call('getScreenshot', { format: 'PNG', width: 0, height: 0, display: 0 }, 20000);
    return img.image;
  }

  async shutdown(): Promise<void> {
    try {
      await this.client.call('setVmState', { state: 'SHUTDOWN' }, 3000);
    } catch {
      // The call often never returns because the emulator exits while handling it.
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stopFrames();
    try {
      this.input?.end();
    } catch {
      /* ignore */
    }
    this.input = undefined;
    this.client.close();
  }
}

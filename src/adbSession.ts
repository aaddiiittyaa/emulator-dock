import { ChildProcess, spawn } from 'child_process';
import { adbExec, adbShell } from './adb';
import type { DeviceSession, Frame, SessionSink, TouchPoint } from './session';

type Size = { width: number; height: number };
type RawFrame = Pick<Frame, 'width' | 'height' | 'data'>;

/** Frames are sent one at a time; if the webview has not acknowledged a frame after this long, send anyway. */
const ACK_TIMEOUT_MS = 1000;
/**
 * Frames cross the cable uncompressed (3 bytes per pixel), so the stream is capped at about
 * one megapixel: sharp in a side panel while keeping the frame rate up over USB.
 */
const MAX_STREAM_PIXELS = 1_000_000;
const INPUT_ACK_TIMEOUT_MS = 4000;
const LONG_PRESS_MS = 500;
/** From Android 12, `input` is a thin `cmd input` wrapper (~15 ms); before that every call boots a VM (~300 ms). */
const FAST_INPUT_SDK = 31;
const PIXEL_FORMAT_RGB_888 = 3;
const INPUT_ACK = '__emulator_dock_ack__';
const MAX_TEXT_CHUNK = 400;

/** W3C `KeyboardEvent.key` values (as sent by the view) to Android key codes. */
const KEYCODES: Record<string, number> = {
  Power: 26,
  AudioVolumeUp: 24,
  AudioVolumeDown: 25,
  GoBack: 4,
  GoHome: 3,
  AppSwitch: 187,
  Backspace: 67,
  Delete: 112,
  Enter: 66,
  Tab: 61,
  Escape: 111,
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Home: 122,
  End: 123,
  PageUp: 92,
  PageDown: 93,
  Insert: 124,
};
/** Device buttons, where holding means a long press (Power opens the power menu). */
const HOLDABLE_KEYS = new Set(['Power', 'AudioVolumeUp', 'AudioVolumeDown', 'GoBack', 'GoHome', 'AppSwitch']);
const KEYCODE_CTRL_LEFT = 113;
const LETTER_KEYCODES: Record<string, number> = { a: 29, c: 31, v: 50, x: 52, y: 53, z: 54 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function onceFinished(child: ChildProcess, callback: () => void): void {
  let done = false;
  const finish = () => {
    if (!done) {
      done = true;
      callback();
    }
  };
  child.on('error', finish);
  child.on('close', finish);
}

/** Largest size with the display's aspect ratio that fits the panel, capped at native resolution and the pixel budget. */
export function streamSize(display: Size, viewport: Size): Size {
  const { width, height } = display;
  let scale = Math.min(1, viewport.width / width, viewport.height / height);
  if (width * height * scale * scale > MAX_STREAM_PIXELS) {
    scale = Math.sqrt(MAX_STREAM_PIXELS / (width * height));
  }
  return { width: Math.max(2, Math.round(width * scale)), height: Math.max(2, Math.round(height * scale)) };
}

/**
 * Decodes raw `screencap` output (12- or 16-byte header, then RGBA/RGBX/BGRA/RGB pixels) into
 * packed RGB888 scaled to fit the viewport, averaging 2x2 samples per output pixel.
 */
export function decodeScreencap(raw: Buffer, viewport: Size): RawFrame | undefined {
  if (raw.length < 12) {
    return undefined;
  }
  const w = raw.readUInt32LE(0);
  const h = raw.readUInt32LE(4);
  const format = raw.readUInt32LE(8);
  const bpp = format === 3 ? 3 : format === 1 || format === 2 || format === 5 ? 4 : 0;
  const header = raw.length - w * h * bpp;
  if (!w || !h || !bpp || header < 12 || header > 16) {
    return undefined;
  }
  const { width: tw, height: th } = streamSize({ width: w, height: h }, viewport);
  const [ri, bi] = format === 5 ? [2, 0] : [0, 2];
  const xs = new Int32Array(tw * 2);
  for (let x = 0; x < tw; x++) {
    xs[2 * x] = Math.min(w - 1, Math.floor(((x + 0.25) * w) / tw)) * bpp;
    xs[2 * x + 1] = Math.min(w - 1, Math.floor(((x + 0.75) * w) / tw)) * bpp;
  }
  const out = new Uint8Array(tw * th * 3);
  let o = 0;
  for (let y = 0; y < th; y++) {
    const r0 = header + Math.min(h - 1, Math.floor(((y + 0.25) * h) / th)) * w * bpp;
    const r1 = header + Math.min(h - 1, Math.floor(((y + 0.75) * h) / th)) * w * bpp;
    for (let x = 0; x < tw; x++) {
      const a = r0 + xs[2 * x];
      const b = r0 + xs[2 * x + 1];
      const c = r1 + xs[2 * x];
      const d = r1 + xs[2 * x + 1];
      out[o++] = (raw[a + ri] + raw[b + ri] + raw[c + ri] + raw[d + ri] + 2) >> 2;
      out[o++] = (raw[a + 1] + raw[b + 1] + raw[c + 1] + raw[d + 1] + 2) >> 2;
      out[o++] = (raw[a + bi] + raw[b + bi] + raw[c + bi] + raw[d + bi] + 2) >> 2;
    }
  }
  return { width: tw, height: th, data: out };
}

/** FIFO of byte chunks that hands out whole messages, copying each byte at most once. */
class ByteQueue {
  private chunks: Buffer[] = [];
  length = 0;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  /** Returns (without consuming) the first `n` bytes; meant for small headers. */
  peek(n: number): Buffer {
    while (this.chunks.length > 1 && this.chunks[0].length < n) {
      this.chunks.splice(0, 2, Buffer.concat([this.chunks[0], this.chunks[1]]));
    }
    return this.chunks.length ? this.chunks[0].subarray(0, n) : Buffer.alloc(0);
  }

  /** Removes and returns the first `n` bytes (`n` must not exceed `length`). */
  take(n: number): Buffer {
    const first = this.chunks[0];
    let out: Buffer;
    if (first.length >= n) {
      out = first.subarray(0, n);
      if (first.length === n) {
        this.chunks.shift();
      } else {
        this.chunks[0] = first.subarray(n);
      }
    } else {
      out = Buffer.allocUnsafe(n);
      let offset = 0;
      while (offset < n) {
        const chunk = this.chunks[0];
        const count = Math.min(chunk.length, n - offset);
        chunk.copy(out, offset, 0, count);
        offset += count;
        if (count === chunk.length) {
          this.chunks.shift();
        } else {
          this.chunks[0] = chunk.subarray(count);
        }
      }
    }
    this.length -= n;
    return out;
  }
}

interface FrameStream {
  child: ChildProcess;
  queue: ByteQueue;
  /** Device-side pid of screenrecord, announced before the first frame. */
  remotePid?: number;
  frames: number;
  output: string;
  done: boolean;
}

type InputItem =
  | { kind: 'command'; command: string }
  | { kind: 'move'; x: number; y: number }
  | { kind: 'scroll'; x: number; y: number; h: number; v: number }
  | { kind: 'text'; text: string };

/**
 * A connection to a device over adb, for phones and tablets (and emulators without gRPC).
 *
 * The screen streams through `screenrecord --output-format=frames`: the device scales each
 * frame to the panel size on its GPU and sends raw RGB888, only when the screen changes.
 * Devices that can't do that fall back to polling `screencap`. Input goes through one
 * persistent `adb shell` running `input` commands, one at a time: pointer moves and scrolls
 * are coalesced while a command is in flight, so input never lags behind the cursor.
 */
export class AdbSession implements DeviceSession {
  private display: Size = { width: 1080, height: 1920 };
  private sdk = 0;
  private viewport: Size = { width: 0, height: 0 };
  private active = true;
  private started = false;
  private disposed = false;
  private asleep = false;

  private streamGeneration = 0;
  private streamKey = '';
  private stream: FrameStream | undefined;
  private mode: 'screenrecord' | 'screencap' = 'screenrecord';
  private failures = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  private inFlightSince = 0;
  private pending: RawFrame | undefined;
  private seq = 0;
  private ackWaiter: (() => void) | undefined;

  private monitor: ChildProcess | undefined;
  private monitorTimer: NodeJS.Timeout | undefined;

  private shell: ChildProcess | undefined;
  private inputQueue: InputItem[] = [];
  private inputBusy = false;
  private inputTimer: NodeJS.Timeout | undefined;
  private inputLogs = 0;
  private gesture: { x0: number; y0: number; x: number; y: number; t0: number } | undefined;
  private hover = { x: 0, y: 0 };
  private readonly heldKeys = new Map<string, { timer: NodeJS.Timeout; long: boolean }>();
  private warned = new Set<string>();

  constructor(readonly adb: string, readonly serial: string, private readonly sink: SessionSink) {}

  get displaySize(): Size {
    return { ...this.display };
  }

  private get liveInput(): boolean {
    return this.sdk >= FAST_INPUT_SDK;
  }

  private warnOnce(key: string, message: string): void {
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.sink.log(message);
    }
  }

  async start(): Promise<void> {
    const out = await adbShell(
      this.adb,
      this.serial,
      "getprop ro.build.version.sdk; dumpsys window displays 2>/dev/null | grep -m1 -oE 'cur=[0-9]+x[0-9]+'; wm size",
      10000,
    );
    if (this.disposed) {
      return;
    }
    this.sdk = parseInt(out, 10) || 0;
    // `cur=` is the logical size in the current orientation; `wm size` is the portrait fallback.
    const size = /cur=(\d+)x(\d+)/.exec(out) ?? /Override size: (\d+)x(\d+)/.exec(out) ?? /Physical size: (\d+)x(\d+)/.exec(out);
    if (!size) {
      throw new Error(`Couldn't read the screen size of ${this.serial}: ${out.trim() || 'no output'}`);
    }
    this.display = { width: Number(size[1]), height: Number(size[2]) };
    this.started = true;
    this.sink.log(`Android API ${this.sdk || 'unknown'}, display ${this.display.width}x${this.display.height}`);
    if (this.active) {
      this.startMonitor();
      this.restartFrames();
    }
  }

  setViewport(width: number, height: number): void {
    this.viewport = { width: Math.round(width), height: Math.round(height) };
    this.restartFrames(false);
  }

  /** Pauses streaming while the panel is hidden. */
  setActive(active: boolean): void {
    if (this.active === active) {
      return;
    }
    this.active = active;
    if (!this.started) {
      return;
    }
    if (active) {
      this.startMonitor();
      this.restartFrames();
    } else {
      this.stopFrames();
      this.stopMonitor();
    }
  }

  /** screenrecord only sends frames on change, so a (re)loaded webview needs a fresh stream. */
  resync(): void {
    this.restartFrames();
    if (this.asleep) {
      this.sink.screenOff();
    }
  }

  frameAck(): void {
    this.inFlightSince = 0;
    const waiter = this.ackWaiter;
    this.ackWaiter = undefined;
    waiter?.();
    if (this.pending) {
      this.deliver(this.pending);
    }
  }

  // ---- Screen ------------------------------------------------------------------------

  private restartFrames(force = true): void {
    if (!this.started || this.disposed || !this.active || this.viewport.width < 16 || this.viewport.height < 16) {
      this.stopFrames();
      return;
    }
    const size = streamSize(this.display, this.viewport);
    const key = `${this.mode}:${size.width}x${size.height}`;
    if (!force && key === this.streamKey) {
      return;
    }
    this.stopFrames();
    this.streamKey = key;
    const generation = this.streamGeneration;
    if (this.mode === 'screencap') {
      void this.screencapLoop(generation);
    } else {
      this.startScreenrecord(generation, size);
    }
  }

  private stopFrames(): void {
    this.streamGeneration++;
    this.streamKey = '';
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const stream = this.stream;
    this.stream = undefined;
    if (stream) {
      this.killStream(stream);
    }
    this.pending = undefined;
    this.inFlightSince = 0;
    const waiter = this.ackWaiter;
    this.ackWaiter = undefined;
    waiter?.();
  }

  private killStream(stream: FrameStream): void {
    stream.done = true;
    stream.child.kill();
    // On a static screen screenrecord writes nothing, so it wouldn't notice the closed pipe; stop it directly.
    const pid = stream.remotePid;
    if (pid) {
      adbShell(this.adb, this.serial, `[ "$(cat /proc/${pid}/comm 2>/dev/null)" = screenrecord ] && kill ${pid}`, 5000).catch(() => {
        /* already gone */
      });
    }
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

  private startScreenrecord(generation: number, size: Size): void {
    const command = `echo PID:$$; exec screenrecord --output-format=frames --size ${size.width}x${size.height} -`;
    const child = spawn(this.adb, ['-s', this.serial, 'exec-out', command], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const stream: FrameStream = { child, queue: new ByteQueue(), frames: 0, output: '', done: false };
    this.stream = stream;
    child.stdout!.on('data', (chunk: Buffer) => {
      if (stream.done) {
        return;
      }
      try {
        this.readFrames(stream, chunk);
      } catch (e) {
        this.streamFailed(stream, generation, (e as Error).message, true);
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      stream.output = (stream.output + chunk.toString('utf8')).slice(-1000);
    });
    onceFinished(child, () => {
      if (stream.done) {
        return;
      }
      stream.done = true;
      if (this.stream === stream) {
        this.stream = undefined;
      }
      if (stream.frames === 0) {
        const detail = stream.output.trim();
        this.streamFailed(stream, generation, `screenrecord stopped before sending a frame${detail ? `: ${detail}` : ''}`, false);
      } else {
        // Older Android versions end the recording after 3 minutes; just start a new one.
        this.scheduleRestart(generation);
      }
    });
  }

  private streamFailed(stream: FrameStream, generation: number, reason: string, fatal: boolean): void {
    this.sink.log(reason);
    if (!stream.done) {
      this.killStream(stream);
    }
    if (this.stream === stream) {
      this.stream = undefined;
    }
    this.failures++;
    if ((fatal || this.failures >= 2) && this.mode === 'screenrecord') {
      this.mode = 'screencap';
      this.sink.log('Streaming with screenrecord is not available on this device; falling back to screencap (lower frame rate).');
    }
    this.scheduleRestart(generation);
  }

  /** Parses `PID:<n>\n` and then frames: u32 length, then width, height, stride, format (u32 each) and the pixels. */
  private readFrames(stream: FrameStream, chunk: Buffer): void {
    const queue = stream.queue;
    queue.push(chunk);
    if (stream.remotePid === undefined) {
      const head = queue.peek(Math.min(queue.length, 32));
      const newline = head.indexOf(0x0a);
      if (newline < 0) {
        if (queue.length >= 32) {
          throw new Error(`Unexpected output from screenrecord: ${head.toString('latin1').trim()}`);
        }
        return;
      }
      const match = /^PID:(\d+)\r?$/.exec(head.toString('latin1', 0, newline));
      if (!match) {
        throw new Error(`Unexpected output from screenrecord: ${head.toString('latin1').trim()}`);
      }
      stream.remotePid = Number(match[1]);
      queue.take(newline + 1);
    }
    while (queue.length >= 4) {
      const length = queue.peek(4).readUInt32LE(0);
      if (length < 16 || length > 256 * 1024 * 1024) {
        // Not a frame header: screenrecord printed an error instead (it shares the output stream).
        throw new Error(`screenrecord: ${queue.peek(Math.min(queue.length, 300)).toString('latin1').trim()}`);
      }
      if (queue.length < 4 + length) {
        return;
      }
      queue.take(4);
      const payload = queue.take(length);
      const width = payload.readUInt32LE(0);
      const height = payload.readUInt32LE(4);
      const stride = payload.readUInt32LE(8);
      const format = payload.readUInt32LE(12);
      const rowBytes = width * 3;
      if (format !== PIXEL_FORMAT_RGB_888 || !width || !height || stride < rowBytes || length < 16 + stride * (height - 1) + rowBytes) {
        throw new Error(`Unsupported screenrecord frame: ${width}x${height}, stride ${stride}, format ${format}`);
      }
      let data: Uint8Array;
      if (stride === rowBytes) {
        // Copy into a standalone buffer: the payload may be a view into a larger chunk.
        data = new Uint8Array(payload.subarray(16, 16 + rowBytes * height));
      } else {
        data = new Uint8Array(rowBytes * height);
        for (let y = 0; y < height; y++) {
          payload.copy(data, y * rowBytes, 16 + y * stride, 16 + y * stride + rowBytes);
        }
      }
      stream.frames++;
      this.failures = 0;
      this.onImage({ width, height, data });
    }
  }

  /** Fallback for devices without frame streaming: one full screenshot per acknowledged frame. */
  private async screencapLoop(generation: number): Promise<void> {
    while (generation === this.streamGeneration && !this.disposed) {
      let raw: Buffer;
      try {
        raw = await adbExec(this.adb, ['-s', this.serial, 'exec-out', 'screencap'], 15000);
      } catch (e) {
        if (generation !== this.streamGeneration) {
          return;
        }
        this.sink.log(`screencap failed: ${(e as Error).message}`);
        await sleep(2000);
        continue;
      }
      if (generation !== this.streamGeneration) {
        return;
      }
      const frame = decodeScreencap(raw, this.viewport);
      if (!frame) {
        this.warnOnce('screencap-format', `screencap returned an unsupported image (${raw.length} bytes)`);
        await sleep(2000);
        continue;
      }
      this.onImage(frame);
      await new Promise<void>((resolve) => {
        this.ackWaiter = resolve;
        setTimeout(resolve, ACK_TIMEOUT_MS);
      });
    }
  }

  private onImage(frame: RawFrame): void {
    if (this.inFlightSince && Date.now() - this.inFlightSince < ACK_TIMEOUT_MS) {
      this.pending = frame;
      return;
    }
    this.deliver(frame);
  }

  private deliver(frame: RawFrame): void {
    this.pending = undefined;
    this.inFlightSince = Date.now();
    // Frames arrive already upright, so the view applies no rotation.
    this.sink.frame({ ...frame, rotation: 'PORTRAIT', seq: ++this.seq });
  }

  // ---- Display state -----------------------------------------------------------------

  /** Watches the logical display size (it swaps on rotation) and whether the screen is on. */
  private startMonitor(): void {
    if (this.monitor || this.disposed) {
      return;
    }
    const script =
      "while :; do echo \"M $(dumpsys window displays 2>/dev/null | grep -m1 -oE 'cur=[0-9]+x[0-9]+') " +
      "$(dumpsys power 2>/dev/null | grep -m1 -oE 'mWakefulness=[A-Za-z]+')\"; sleep 1; done";
    const child = spawn(this.adb, ['-s', this.serial, 'shell', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    this.monitor = child;
    let buffered = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      lines.forEach((line) => this.onMonitorLine(line));
    });
    onceFinished(child, () => {
      if (this.monitor !== child) {
        return;
      }
      this.monitor = undefined;
      if (!this.disposed && this.active) {
        this.monitorTimer = setTimeout(() => {
          this.monitorTimer = undefined;
          this.startMonitor();
        }, 3000);
      }
    });
  }

  private stopMonitor(): void {
    clearTimeout(this.monitorTimer);
    this.monitorTimer = undefined;
    const monitor = this.monitor;
    this.monitor = undefined;
    monitor?.kill();
  }

  private onMonitorLine(line: string): void {
    const size = /cur=(\d+)x(\d+)/.exec(line);
    if (size) {
      const width = Number(size[1]);
      const height = Number(size[2]);
      if (width !== this.display.width || height !== this.display.height) {
        this.display = { width, height };
        this.sink.log(`Display is now ${width}x${height}`);
        this.restartFrames();
      }
    }
    const wake = /mWakefulness=(\w+)/.exec(line);
    if (wake) {
      const asleep = wake[1] === 'Asleep';
      if (asleep !== this.asleep) {
        this.asleep = asleep;
        if (asleep) {
          this.sink.screenOff();
        } else {
          // screenrecord sends a first frame as soon as it starts.
          this.restartFrames();
        }
      }
    }
  }

  // ---- Input -------------------------------------------------------------------------

  private toDevice(nx: number, ny: number) {
    const { width: w, height: h } = this.display;
    return {
      x: Math.min(w - 1, Math.round(clamp01(nx) * w)),
      y: Math.min(h - 1, Math.round(clamp01(ny) * h)),
    };
  }

  private enqueue(item: InputItem): void {
    if (this.disposed) {
      return;
    }
    const tail = this.inputQueue[this.inputQueue.length - 1];
    if (tail?.kind === 'move' && item.kind === 'move') {
      tail.x = item.x;
      tail.y = item.y;
    } else if (tail?.kind === 'scroll' && item.kind === 'scroll') {
      tail.x = item.x;
      tail.y = item.y;
      tail.h += item.h;
      tail.v += item.v;
    } else if (tail?.kind === 'text' && item.kind === 'text' && tail.text.length + item.text.length <= MAX_TEXT_CHUNK) {
      tail.text += item.text;
    } else {
      this.inputQueue.push(item);
    }
    this.pumpInput();
  }

  private render(item: InputItem): string | undefined {
    switch (item.kind) {
      case 'command':
        return item.command;
      case 'move':
        return `input motionevent MOVE ${item.x} ${item.y}`;
      case 'text':
        // `input text` reads "%s" as a space.
        return `input text ${shellQuote(item.text.replace(/ /g, '%s'))}`;
      case 'scroll': {
        if (!this.liveInput) {
          // No scroll injection on older Android: drag the content instead.
          const step = Math.min(this.display.width, this.display.height) * 0.25;
          const { width: w, height: h } = this.display;
          const x2 = Math.min(w - 1, Math.max(0, Math.round(item.x - item.h * step)));
          const y2 = Math.min(h - 1, Math.max(0, Math.round(item.y + item.v * step)));
          return x2 === item.x && y2 === item.y ? undefined : `input swipe ${item.x} ${item.y} ${x2} ${y2} 150`;
        }
        const axes = [
          ['VSCROLL', item.v],
          ['HSCROLL', item.h],
        ] as const;
        const args = axes.filter(([, v]) => Math.abs(v) >= 0.01).map(([axis, v]) => `--axis ${axis},${v.toFixed(2)}`);
        return args.length ? `input mouse scroll ${item.x} ${item.y} ${args.join(' ')}` : undefined;
      }
    }
  }

  private pumpInput(): void {
    while (!this.inputBusy && this.inputQueue.length && !this.disposed) {
      const item = this.inputQueue.shift()!;
      const command = this.render(item);
      if (!command) {
        continue;
      }
      const shell = this.ensureShell();
      this.inputBusy = true;
      const timeout = INPUT_ACK_TIMEOUT_MS + (item.kind === 'text' ? item.text.length * 25 : 0);
      this.inputTimer = setTimeout(() => this.onInputTimeout(), timeout);
      shell.stdin!.write(`${command} 2>&1; echo ${INPUT_ACK}\n`);
    }
  }

  private ensureShell(): ChildProcess {
    if (this.shell) {
      return this.shell;
    }
    const child = spawn(this.adb, ['-s', this.serial, 'shell'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.shell = child;
    let buffered = '';
    const onOutput = (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        if (line === INPUT_ACK) {
          if (this.shell === child) {
            this.onInputAck();
          }
        } else if (line.trim() && !line.includes(INPUT_ACK) && this.inputLogs < 20) {
          this.inputLogs++;
          this.sink.log(`input: ${line.trim()}`);
        }
      }
    };
    child.stdout!.on('data', onOutput);
    child.stderr!.on('data', onOutput);
    child.stdin!.on('error', () => {
      /* EPIPE when the device goes away; handled on close */
    });
    onceFinished(child, () => {
      if (this.shell !== child) {
        return;
      }
      this.shell = undefined;
      clearTimeout(this.inputTimer);
      this.inputBusy = false;
      // Whatever was queued is stale by now; the next input starts a new shell.
      this.inputQueue = [];
    });
    return child;
  }

  private onInputAck(): void {
    clearTimeout(this.inputTimer);
    this.inputBusy = false;
    this.pumpInput();
  }

  private onInputTimeout(): void {
    this.sink.log('An input command did not finish in time; restarting the input shell.');
    const shell = this.shell;
    this.shell = undefined;
    shell?.kill();
    this.inputBusy = false;
    this.pumpInput();
  }

  pointer(nx: number, ny: number, buttons: number): void {
    const { x, y } = this.toDevice(nx, ny);
    this.hover = { x, y };
    const gesture = this.gesture;
    if (buttons && !gesture) {
      this.gesture = { x0: x, y0: y, x, y, t0: Date.now() };
      if (this.liveInput) {
        this.enqueue({ kind: 'command', command: `input motionevent DOWN ${x} ${y}` });
      }
    } else if (buttons && gesture) {
      gesture.x = x;
      gesture.y = y;
      if (this.liveInput) {
        this.enqueue({ kind: 'move', x, y });
      }
    } else if (gesture) {
      this.gesture = undefined;
      if (this.liveInput) {
        this.enqueue({ kind: 'command', command: `input motionevent UP ${x} ${y}` });
        return;
      }
      // Older Android: each `input` call is slow, so replay the gesture as one tap or swipe.
      const duration = Math.min(3000, Date.now() - gesture.t0);
      const slop = Math.max(8, Math.min(this.display.width, this.display.height) * 0.01);
      const { x0, y0 } = gesture;
      let command: string;
      if (Math.hypot(x - x0, y - y0) >= slop) {
        command = `input swipe ${x0} ${y0} ${x} ${y} ${Math.max(60, duration)}`;
      } else if (duration >= LONG_PRESS_MS) {
        command = `input swipe ${x0} ${y0} ${x0} ${y0} ${duration}`;
      } else {
        command = `input tap ${x0} ${y0}`;
      }
      this.enqueue({ kind: 'command', command });
    }
  }

  /** `input` injects a single pointer, so multi-touch (Alt+drag pinch) becomes a one-finger drag. */
  touch(points: TouchPoint[]): void {
    const point = points[0];
    if (point) {
      this.pointer(point.nx, point.ny, point.pressure > 0 ? 1 : 0);
    }
  }

  /** Wheel deltas use 120 units per notch; positive dy scrolls up, positive dx scrolls left. */
  wheel(dx: number, dy: number): void {
    const { x, y } = this.hover;
    this.enqueue({ kind: 'scroll', x, y, h: -dx / 120, v: dy / 120 });
  }

  key(key: string, eventType: 'keydown' | 'keyup' | 'keypress' = 'keypress'): void {
    const code = KEYCODES[key];
    if (code === undefined) {
      return;
    }
    if (!HOLDABLE_KEYS.has(key) || eventType === 'keypress') {
      if (eventType !== 'keyup') {
        this.enqueue({ kind: 'command', command: `input keyevent ${code}` });
      }
      return;
    }
    if (eventType === 'keydown') {
      if (this.heldKeys.has(key)) {
        return;
      }
      const held = {
        long: false,
        timer: setTimeout(() => {
          held.long = true;
          this.enqueue({ kind: 'command', command: `input keyevent --longpress ${code}` });
        }, LONG_PRESS_MS),
      };
      this.heldKeys.set(key, held);
      return;
    }
    const held = this.heldKeys.get(key);
    if (held) {
      this.heldKeys.delete(key);
      clearTimeout(held.timer);
      if (!held.long) {
        this.enqueue({ kind: 'command', command: `input keyevent ${code}` });
      }
    }
  }

  text(text: string): void {
    const ascii = text.replace(/[^\x20-\x7e]/g, '');
    if (ascii.length !== text.length) {
      this.warnOnce('non-ascii', 'Only ASCII characters can be typed into a device over adb; others are skipped.');
    }
    if (ascii) {
      this.enqueue({ kind: 'text', text: ascii });
    }
  }

  /** Ctrl+<letter> on the device (select all, undo...). Needs Android 13+ for `input keycombination`. */
  ctrlCombo(letter: string): void {
    const code = LETTER_KEYCODES[letter];
    if (code !== undefined) {
      this.enqueue({ kind: 'command', command: `input keycombination ${KEYCODE_CTRL_LEFT} ${code}` });
    }
  }

  /** adb can't write the device clipboard, so pasting types the text instead. */
  async paste(text: string): Promise<void> {
    let skipped = 0;
    for (const part of text.replace(/\r\n?/g, '\n').split(/([\n\t])/)) {
      if (part === '\n' || part === '\t') {
        this.enqueue({ kind: 'command', command: `input keyevent ${part === '\n' ? KEYCODES.Enter : KEYCODES.Tab}` });
        continue;
      }
      const ascii = part.replace(/[^\x20-\x7e]/g, '');
      skipped += part.length - ascii.length;
      for (let i = 0; i < ascii.length; i += MAX_TEXT_CHUNK) {
        this.enqueue({ kind: 'text', text: ascii.slice(i, i + MAX_TEXT_CHUNK) });
      }
    }
    if (skipped) {
      throw new Error(
        `Pasted by typing the text. ${skipped} non-ASCII character${skipped === 1 ? '' : 's'} can't be typed into a device over adb and ${skipped === 1 ? 'was' : 'were'} skipped.`,
      );
    }
  }

  /** Copies on the device, but adb can't read the device clipboard back. */
  async copyFromDevice(cut: boolean): Promise<string> {
    this.ctrlCombo(cut ? 'x' : 'c');
    this.warnOnce('copy', "Copying from a device connected over adb isn't supported: adb can't read its clipboard.");
    return '';
  }

  /** Locks the device to the next orientation (this turns auto-rotate off, as the quick setting would). */
  async rotate(direction: 1 | -1): Promise<void> {
    const out = await adbShell(this.adb, this.serial, "dumpsys input 2>/dev/null | grep -m1 -oE '(orientation=|SurfaceOrientation: )[0-3]'", 8000).catch(
      () => '',
    );
    const current = Number(/([0-3])\s*$/.exec(out.trim())?.[1] ?? 0);
    const next = (current + (direction === 1 ? 1 : 3)) % 4;
    await adbShell(this.adb, this.serial, `settings put system accelerometer_rotation 0 && settings put system user_rotation ${next}`, 8000);
  }

  async screenshotPng(): Promise<Buffer> {
    const png = await adbExec(this.adb, ['-s', this.serial, 'exec-out', 'screencap', '-p'], 30000);
    if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) {
      throw new Error(png.toString('utf8', 0, 200).trim() || 'The device returned no image.');
    }
    return png;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stopFrames();
    this.stopMonitor();
    this.heldKeys.forEach((held) => clearTimeout(held.timer));
    this.heldKeys.clear();
    clearTimeout(this.inputTimer);
    this.inputQueue = [];
    const shell = this.shell;
    this.shell = undefined;
    if (shell) {
      // Lift a finger that is still down so the device isn't left mid-gesture, then let the shell exit.
      const lift = this.gesture && this.liveInput ? `input motionevent UP ${this.gesture.x} ${this.gesture.y}\n` : '';
      shell.stdin!.end(`${lift}exit\n`);
      setTimeout(() => shell.kill(), 3000).unref();
    }
  }
}

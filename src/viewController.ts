import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { SkinRotation } from './emulatorClient';
import { DeviceRegistry, protoPath } from './registry';
import { readCornerRadius } from './sdk';
import { EmulatorSession, TouchPoint } from './session';

type Status = 'noSdk' | 'idle' | 'launching' | 'connecting' | 'connected' | 'error';

const HARDWARE_KEYS: Record<string, string> = {
  power: 'Power',
  volumeUp: 'AudioVolumeUp',
  volumeDown: 'AudioVolumeDown',
  back: 'GoBack',
  home: 'GoHome',
  overview: 'AppSwitch',
};

/** Keys the webview may forward as key events (everything printable goes through `text`). */
const ALLOWED_KEYS = new Set([
  'Backspace', 'Delete', 'Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', 'Insert',
]);

let lastActive: EmulatorViewController | undefined;
const controllers = new Set<EmulatorViewController>();
/** Screen corner radius as a fraction of the display's short side, per emulator pid. */
const cornerRatios = new Map<number, number | null>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function activeController(): EmulatorViewController | undefined {
  if (lastActive && controllers.has(lastActive)) {
    return lastActive;
  }
  return [...controllers][0];
}

/**
 * Drives one webview (the docked view or an editor tab): renders the device list and
 * owns the streaming session for whichever emulator that webview shows.
 */
export class EmulatorViewController implements vscode.Disposable {
  private session: EmulatorSession | undefined;
  private status: Status = 'idle';
  private message = '';
  private pendingLaunch: string | undefined;
  private wantedPid: number | undefined;
  private viewport: { width: number; height: number } | undefined;
  private visible = true;
  private cornerRatio: number | null | undefined;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly webview: vscode.Webview,
    private readonly context: vscode.ExtensionContext,
    private readonly registry: DeviceRegistry,
    private readonly log: vscode.LogOutputChannel,
    host: 'sidebar' | 'editor',
    initialPid?: number,
  ) {
    this.wantedPid = initialPid;
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    webview.options = { enableScripts: true, localResourceRoots: [media] };
    webview.html = renderHtml(webview, media, host);
    this.disposables.push(
      webview.onDidReceiveMessage((m) => this.onMessage(m)),
      registry.onDidChange(() => this.onRegistryChange()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('emulatorDock.screenQuality')) {
          this.sendState();
        }
      }),
    );
    controllers.add(this);
    lastActive = this;
  }

  get connectedEmulator() {
    return this.session?.emulator;
  }

  toggleFullscreen(): void {
    lastActive = this;
    this.post({ type: 'toggleFullscreen' });
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.session?.setActive(visible);
    if (visible) {
      lastActive = this;
    }
  }

  // ---- State ---------------------------------------------------------------------

  private post(message: object): void {
    if (!this.disposed) {
      void this.webview.postMessage(message);
    }
  }

  private setStatus(status: Status, message = ''): void {
    this.status = status;
    this.message = message;
    this.sendState();
  }

  private effectiveStatus(): { status: Status; message: string } {
    if (!this.registry.ready && !this.session) {
      return { status: 'connecting', message: '' };
    }
    if (!this.registry.sdkPath && !this.session && this.registry.running.length === 0) {
      return { status: 'noSdk', message: '' };
    }
    if (this.pendingLaunch && this.registry.isLaunching(this.pendingLaunch) && !this.session) {
      return { status: 'launching', message: this.registry.displayNameFor(this.pendingLaunch) };
    }
    return { status: this.status, message: this.message };
  }

  private sendState(): void {
    const { status, message } = this.effectiveStatus();
    this.post({
      type: 'state',
      status,
      message,
      devices: this.registry.entries,
      selectedKey: this.session ? `run:${this.session.emulator.pid}` : undefined,
      deviceName: this.session?.emulator.avdName,
      platform: process.platform,
      quality: vscode.workspace.getConfiguration('emulatorDock').get<string>('screenQuality', 'auto'),
      cornerRatio: this.session ? this.cornerRatio : undefined,
    });
  }

  private onRegistryChange(): void {
    if (this.session && !this.registry.running.some((r) => r.pid === this.session!.emulator.pid)) {
      const name = this.session.emulator.avdName;
      this.disconnect();
      this.setStatus('idle', `${name} was stopped.`);
    }
    if (!this.session && this.status !== 'connecting') {
      const running = this.registry.running;
      const target =
        (this.wantedPid !== undefined ? running.find((r) => r.pid === this.wantedPid) : undefined) ??
        (this.pendingLaunch ? running.find((r) => r.avdId === this.pendingLaunch) : undefined) ??
        (vscode.workspace.getConfiguration('emulatorDock').get<boolean>('autoConnect', true) && this.status !== 'error' ? running[0] : undefined);
      if (target) {
        void this.connect(target.pid);
        return;
      }
    }
    this.sendState();
  }

  // ---- Connection ----------------------------------------------------------------

  async connect(pid: number): Promise<void> {
    const emulator = this.registry.running.find((r) => r.pid === pid);
    if (!emulator || this.session?.emulator.pid === pid) {
      return;
    }
    this.disconnect();
    this.pendingLaunch = undefined;
    this.wantedPid = undefined;
    const session = new EmulatorSession(emulator, protoPath(this.context), {
      frame: (frame) => this.post({ type: 'frame', ...frame }),
      screenOff: () => this.post({ type: 'screenOff' }),
      log: (msg) => this.log.info(`[${emulator.avdId}] ${msg}`),
    });
    this.session = session;
    this.setStatus('connecting', emulator.avdName);
    try {
      session.setActive(this.visible);
      await session.start();
      if (this.session !== session) {
        return;
      }
      if (this.viewport) {
        session.setViewport(this.viewport.width, this.viewport.height);
      }
      const { width, height } = session.displaySize;
      this.log.info(`Connected to ${emulator.avdId} on gRPC port ${emulator.grpcPort} (display ${width}x${height})`);
      this.setStatus('connected');
      void this.loadCornerRadius(session);
    } catch (e) {
      if (this.session !== session) {
        return;
      }
      const err = e as Error & { details?: string };
      this.log.error(`Could not connect to ${emulator.avdId}: ${err.details || err.message}`);
      this.disconnect();
      this.setStatus('error', `Couldn't connect to ${emulator.avdName}: ${err.details || err.message}`);
    }
  }

  private disconnect(): void {
    this.session?.dispose();
    this.session = undefined;
    this.cornerRatio = undefined;
  }

  /** Asks Android for the screen's corner radius so the panel clips exactly where the device does. */
  private async loadCornerRadius(session: EmulatorSession): Promise<void> {
    const { pid, serialPort, avdId } = session.emulator;
    const sdk = this.registry.sdkPath;
    if (cornerRatios.has(pid)) {
      this.cornerRatio = cornerRatios.get(pid);
      this.sendState();
      return;
    }
    if (!sdk || !serialPort) {
      return;
    }
    // A freshly launched device answers only once it has booted, so keep asking for a while.
    for (let attempt = 0; attempt < 45 && this.session === session; attempt++) {
      const radius = await readCornerRadius(sdk, `emulator-${serialPort}`);
      if (this.session !== session) {
        return;
      }
      if (radius !== undefined) {
        const { width, height } = session.displaySize;
        const ratio = radius === null ? null : radius / Math.min(width, height);
        cornerRatios.set(pid, ratio);
        this.cornerRatio = ratio;
        this.log.info(`[${avdId}] screen corner radius: ${radius ?? 'none reported'}`);
        this.sendState();
        return;
      }
      await sleep(4000);
    }
  }

  async launch(avdId: string): Promise<void> {
    lastActive = this;
    const running = this.registry.running.find((r) => r.avdId === avdId);
    if (running) {
      await this.connect(running.pid);
      return;
    }
    this.disconnect();
    this.pendingLaunch = avdId;
    this.status = 'idle';
    try {
      await this.registry.launch(avdId);
    } catch (e) {
      this.pendingLaunch = undefined;
      this.setStatus('error', (e as Error).message);
      return;
    }
    this.sendState();
  }

  async stop(): Promise<void> {
    const emulator = this.session?.emulator;
    if (emulator) {
      this.setStatus('connecting', `Stopping ${emulator.avdName}…`);
      await this.registry.stop(emulator);
    }
  }

  async screenshot(): Promise<void> {
    const session = this.session;
    if (!session) {
      void vscode.window.showWarningMessage('No emulator is connected.');
      return;
    }
    const png = await session.screenshotPng();
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+/, '');
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(folder, `${session.emulator.avdId}-${stamp}.png`),
      filters: { 'PNG image': ['png'] },
      title: 'Save emulator screenshot',
    });
    if (!target) {
      return;
    }
    await vscode.workspace.fs.writeFile(target, png);
    const choice = await vscode.window.showInformationMessage(`Saved screenshot to ${path.basename(target.fsPath)}`, 'Open');
    if (choice) {
      await vscode.commands.executeCommand('vscode.open', target);
    }
  }

  // ---- Webview messages ------------------------------------------------------------

  private async onMessage(m: any): Promise<void> {
    const session = this.session;
    if (m?.type !== 'frameAck' && m?.type !== 'viewport') {
      lastActive = this;
    }
    try {
      switch (m?.type) {
        case 'ready':
          this.sendState();
          if (this.session) {
            this.session.resync();
          } else {
            this.onRegistryChange();
          }
          break;
        case 'viewport':
          this.viewport = { width: Number(m.width) || 0, height: Number(m.height) || 0 };
          session?.setViewport(this.viewport.width, this.viewport.height);
          break;
        case 'frameAck':
          session?.frameAck();
          break;
        case 'pointer':
          session?.pointer(m.nx, m.ny, m.buttons ? 1 : 0, m.rotation as SkinRotation);
          break;
        case 'touch':
          session?.touch((m.points as TouchPoint[]).slice(0, 10), m.rotation as SkinRotation);
          break;
        case 'wheel':
          session?.wheel(Number(m.dx) || 0, Number(m.dy) || 0);
          break;
        case 'key':
          if (ALLOWED_KEYS.has(m.key)) {
            session?.key(m.key, m.eventType === 'keyup' ? 'keyup' : 'keydown');
          }
          break;
        case 'text':
          session?.text(String(m.text ?? ''));
          break;
        case 'combo':
          if (/^[azy]$/.test(m.letter)) {
            session?.ctrlCombo(m.letter);
          }
          break;
        case 'paste':
          if (session) {
            await session.paste(await vscode.env.clipboard.readText());
          }
          break;
        case 'copy':
        case 'cut':
          if (session) {
            const text = await session.copyFromDevice(m.type === 'cut');
            if (text) {
              await vscode.env.clipboard.writeText(text);
            }
          }
          break;
        case 'button': {
          const key = HARDWARE_KEYS[m.name];
          if (key && session) {
            session.key(key, m.phase === 'down' ? 'keydown' : m.phase === 'up' ? 'keyup' : 'keypress');
          }
          break;
        }
        case 'rotate':
          lastActive = this;
          await session?.rotate(m.direction === -1 ? -1 : 1);
          break;
        case 'select':
          lastActive = this;
          if (typeof m.key === 'string' && m.key.startsWith('run:')) {
            await this.connect(Number(m.key.slice(4)));
          } else if (typeof m.key === 'string' && m.key.startsWith('avd:')) {
            await this.launch(m.key.slice(4));
          }
          break;
        case 'command':
          lastActive = this;
          await this.runCommand(String(m.name));
          break;
      }
    } catch (e) {
      const err = e as Error & { details?: string };
      this.log.error(`${m?.type} failed: ${err.details || err.message}`);
      if (m?.type === 'command' || m?.type === 'paste' || m?.type === 'rotate') {
        void vscode.window.showErrorMessage(`Android Emulator: ${err.details || err.message}`);
      }
    }
  }

  private async runCommand(name: string): Promise<void> {
    switch (name) {
      case 'screenshot':
        await this.screenshot();
        break;
      case 'stop':
        await this.stop();
        break;
      case 'retry':
        this.status = 'idle';
        await this.registry.refresh();
        this.onRegistryChange();
        break;
      case 'refresh':
        await this.registry.refresh();
        break;
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'emulatorDock.sdkPath');
        break;
      case 'showLogs':
        this.log.show();
        break;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.disconnect();
    controllers.delete(this);
    if (lastActive === this) {
      lastActive = undefined;
    }
    this.disposables.forEach((d) => d.dispose());
  }
}

export function renderHtml(webview: vscode.Webview, media: vscode.Uri, host: 'sidebar' | 'editor'): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.css'));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Android Emulator</title>
</head>
<body data-host="${host}">
<div class="app">
  <header class="toolbar">
    <label class="device-picker">
      <span class="visually-hidden">Device</span>
      <select id="device"></select>
    </label>
    <div class="actions" role="toolbar" aria-label="Device controls">
      <button class="icon" data-rotate="1" data-needs-device title="Rotate left">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.75 6.5a5.25 5.25 0 1 1 1.4 4.9"/><path d="M2.75 2.75v3.75h3.75"/></svg>
      </button>
      <button class="icon" data-rotate="-1" data-needs-device title="Rotate right">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.25 6.5a5.25 5.25 0 1 0-1.4 4.9"/><path d="M13.25 2.75v3.75H9.5"/></svg>
      </button>
      <span class="sep" aria-hidden="true"></span>
      <button class="icon" data-button="volumeDown" data-needs-device title="Volume down">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6.25h2.5L8 3.5v9l-3.5-2.75H2z"/><path d="M10.75 8h3.5"/></svg>
      </button>
      <button class="icon" data-button="volumeUp" data-needs-device title="Volume up">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6.25h2.5L8 3.5v9l-3.5-2.75H2z"/><path d="M10.75 8h3.5M12.5 6.25v3.5"/></svg>
      </button>
      <button class="icon" data-button="power" data-needs-device title="Power (hold for power menu)">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.75v5.5"/><path d="M4.7 3.9a5.25 5.25 0 1 0 6.6 0"/></svg>
      </button>
      <span class="sep" aria-hidden="true"></span>
      <button class="icon" data-command="screenshot" data-needs-device title="Take screenshot">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5.25h2.4l1.3-1.75h4.6l1.3 1.75H14v7.5H2z"/><circle cx="8" cy="8.75" r="2.25"/></svg>
      </button>
      <button class="icon" data-command="stop" data-needs-device title="Stop emulator">
        <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.75" y="3.75" width="8.5" height="8.5" rx="1.5"/></svg>
      </button>
      <span class="sep" aria-hidden="true"></span>
      <button class="icon" id="fsEnter" title="Fullscreen: hide controls and maximize the screen">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.75 6V2.75H6M10 2.75h3.25V6M13.25 10v3.25H10M6 13.25H2.75V10"/></svg>
      </button>
    </div>
  </header>
  <main class="stage" id="stage">
    <div class="screen-wrap" id="screenWrap" hidden>
      <canvas id="screen" tabindex="0" aria-label="Emulator screen. Click to interact; type to send keys."></canvas>
      <div class="screen-off" id="screenOff" hidden>
        <p>Screen is off</p>
        <button class="btn secondary" data-button="power">Wake</button>
      </div>
    </div>
    <div class="overlay" id="overlay" aria-live="polite"></div>
    <button class="fs-exit" id="fsExit" title="">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2.75V6H2.75M13.25 6H10V2.75M10 13.25V10h3.25M2.75 10H6v3.25"/></svg>
      <span></span>
    </button>
  </main>
  <footer class="navbar" id="navbar" hidden>
    <button class="nav" data-button="back" title="Back">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11 3.25 4.5 8l6.5 4.75z"/></svg>
    </button>
    <button class="nav" data-button="home" title="Home">
      <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4.75"/></svg>
    </button>
    <button class="nav" data-button="overview" title="Overview">
      <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/></svg>
    </button>
  </footer>
</div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

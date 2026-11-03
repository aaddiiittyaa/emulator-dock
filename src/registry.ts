import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { discoverRunningEmulators, registrationDirectory, RunningEmulator } from './discovery';
import { EmulatorClient } from './emulatorClient';
import { AvdInfo, launchEmulator, listAvds, resolveSdkPath, tailFile } from './sdk';

export interface DeviceEntry {
  /** `run:<pid>` for a running emulator, `avd:<id>` for one that can be launched. */
  key: string;
  label: string;
  avdId: string;
  state: 'running' | 'launching' | 'stopped';
  pid?: number;
  serial?: string;
}

interface LaunchRecord {
  startedAt: number;
  logFile: string;
}

const LAUNCH_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Emulators launched with "stop on exit" are started with this gRPC idle timeout. While any
 * VS Code window is open it pings them (see heartbeat), so they survive window reloads; once
 * VS Code is closed the pings stop and the emulator shuts itself down gracefully.
 */
export const IDLE_TIMEOUT_SEC = 120;
const HEARTBEAT_MAX_INTERVAL_MS = 30 * 1000;

/** Shared, extension-wide view of the SDK, the available AVDs and the running emulators. */
export class DeviceRegistry implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  sdkPath: string | undefined;
  avds: AvdInfo[] = [];
  running: RunningEmulator[] = [];

  /** True once the first scan for running emulators has finished. */
  ready = false;

  private readonly launching = new Map<string, LaunchRecord>();
  private readonly heartbeatClients = new Map<number, EmulatorClient>();
  private readonly lastHeartbeat = new Map<number, number>();

  private readonly timer: NodeJS.Timeout;
  private watcher: fs.FSWatcher | undefined;
  private snapshot = '';
  private polling = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext, private readonly log: vscode.LogOutputChannel) {
    this.timer = setInterval(() => void this.pollRunning(), 2000);
    this.watchRegistrations();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('emulatorDock.sdkPath')) {
          void this.refresh();
        }
      }),
    );
  }

  private get config() {
    return vscode.workspace.getConfiguration('emulatorDock');
  }

  private watchRegistrations(): void {
    const dir = registrationDirectory();
    try {
      this.watcher = fs.watch(dir, () => void this.pollRunning());
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch {
      // Directory doesn't exist until the first emulator starts; polling covers it.
      this.watcher = undefined;
    }
  }

  async refresh(): Promise<void> {
    this.sdkPath = resolveSdkPath(this.config.get<string>('sdkPath'));
    // Running emulators first (fast) so panels reconnect immediately after a reload;
    // the AVD list (which shells out to the emulator binary) follows.
    await this.pollRunning(true);
    this.avds = this.sdkPath ? await listAvds(this.sdkPath) : [];
    this.log.info(this.sdkPath ? `Android SDK: ${this.sdkPath} (${this.avds.length} AVDs)` : 'Android SDK not found');
    this.changeEmitter.fire();
  }

  private async pollRunning(force = false): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      if (!this.watcher) {
        this.watchRegistrations();
      }
      const running = await discoverRunningEmulators();
      for (const [avdId, record] of this.launching) {
        if (running.some((r) => r.avdId === avdId)) {
          this.launching.delete(avdId);
        } else if (Date.now() - record.startedAt > LAUNCH_TIMEOUT_MS) {
          this.launching.delete(avdId);
          this.log.warn(`${avdId} did not come up within ${LAUNCH_TIMEOUT_MS / 1000}s. Log: ${record.logFile}`);
        }
      }
      this.running = running;
      this.heartbeat();
      const first = !this.ready;
      this.ready = true;
      const snapshot = JSON.stringify([running.map((r) => [r.pid, r.avdId, r.grpcPort]), [...this.launching.keys()]]);
      if (force || first || snapshot !== this.snapshot) {
        this.snapshot = snapshot;
        this.changeEmitter.fire();
      }
    } finally {
      this.polling = false;
    }
  }

  /** Keeps emulators that were launched with an idle timeout alive while VS Code is open. */
  private heartbeat(): void {
    const now = Date.now();
    const alive = new Set<number>();
    for (const emulator of this.running) {
      if (!emulator.idleTimeoutSec) {
        continue;
      }
      alive.add(emulator.pid);
      const interval = Math.min(HEARTBEAT_MAX_INTERVAL_MS, (emulator.idleTimeoutSec * 1000) / 4);
      if (now - (this.lastHeartbeat.get(emulator.pid) ?? 0) < interval) {
        continue;
      }
      this.lastHeartbeat.set(emulator.pid, now);
      let client = this.heartbeatClients.get(emulator.pid);
      if (!client) {
        client = new EmulatorClient(emulator, protoPath(this.context));
        this.heartbeatClients.set(emulator.pid, client);
      }
      client.call('getStatus', {}, 5000).catch(() => {
        /* the next poll retries; a stopped emulator drops out of `running` */
      });
    }
    for (const [pid, client] of this.heartbeatClients) {
      if (!alive.has(pid)) {
        client.close();
        this.heartbeatClients.delete(pid);
        this.lastHeartbeat.delete(pid);
      }
    }
  }

  isLaunching(avdId: string): boolean {
    return this.launching.has(avdId);
  }

  displayNameFor(avdId: string): string {
    return this.avds.find((a) => a.id === avdId)?.displayName ?? this.running.find((r) => r.avdId === avdId)?.avdName ?? avdId;
  }

  get entries(): DeviceEntry[] {
    const entries: DeviceEntry[] = this.running.map((r) => ({
      key: `run:${r.pid}`,
      label: r.avdName,
      avdId: r.avdId,
      state: 'running',
      pid: r.pid,
      serial: r.serialPort ? `emulator-${r.serialPort}` : undefined,
    }));
    for (const avd of this.avds) {
      if (!this.running.some((r) => r.avdId === avd.id)) {
        entries.push({
          key: `avd:${avd.id}`,
          label: avd.displayName,
          avdId: avd.id,
          state: this.launching.has(avd.id) ? 'launching' : 'stopped',
        });
      }
    }
    return entries;
  }

  async launch(avdId: string): Promise<void> {
    if (!this.sdkPath) {
      throw new Error('Android SDK not found. Set "emulatorDock.sdkPath" in settings.');
    }
    if (this.running.some((r) => r.avdId === avdId) || this.launching.has(avdId)) {
      return;
    }
    const logFile = path.join(this.context.logUri.fsPath, `emulator-${avdId}.log`);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, '');
    const { child, args } = launchEmulator(this.sdkPath, avdId, {
      hideWindow: this.config.get<boolean>('launch.hideStandaloneWindow', true),
      extraArgs: this.config.get<string[]>('launch.extraArgs', []),
      logFile,
      idleTimeoutSec: this.config.get<boolean>('stopOnExit', true) ? IDLE_TIMEOUT_SEC : undefined,
    });
    this.log.info(`Launching ${avdId}: emulator ${args.join(' ')} (log: ${logFile})`);
    this.launching.set(avdId, { startedAt: Date.now(), logFile });
    this.changeEmitter.fire();

    const fail = (reason: string) => {
      if (!this.launching.delete(avdId)) {
        return;
      }
      this.changeEmitter.fire();
      const tail = tailFile(logFile, 15);
      this.log.error(`${avdId} failed to start: ${reason}\n${tail}`);
      // The first ERROR/FATAL/PANIC line is the cause; later ones are usually hints.
      const firstError =
        tail
          .split('\n')
          .find((l) => /^(ERROR|FATAL|PANIC)\b/i.test(l.trim()))
          ?.replace(/^\s*\w+\s*\|\s*/, '') ?? reason;
      void vscode.window.showErrorMessage(`Emulator "${this.displayNameFor(avdId)}" failed to start: ${firstError}`, 'Show Log').then((choice) => {
        if (choice) {
          void vscode.window.showTextDocument(vscode.Uri.file(logFile));
        }
      });
    };
    child.on('error', (err) => fail(err.message));
    child.on('exit', (code, signal) => {
      // A clean exit can just mean the launcher handed off to the emulator process.
      if (code !== 0 || signal) {
        fail(signal ? `terminated by ${signal}` : `exit code ${code}`);
      }
    });
  }

  async stop(emulator: RunningEmulator): Promise<void> {
    this.log.info(`Stopping ${emulator.avdId} (pid ${emulator.pid})`);
    const client = new EmulatorClient(emulator, protoPath(this.context));
    try {
      await client.call('setVmState', { state: 'SHUTDOWN' }, 3000);
    } catch {
      // Expected: the emulator usually exits before replying.
    } finally {
      client.close();
    }
  }

  dispose(): void {
    clearInterval(this.timer);
    this.heartbeatClients.forEach((c) => c.close());
    this.heartbeatClients.clear();
    this.watcher?.close();
    this.changeEmitter.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

export function protoPath(context: vscode.ExtensionContext): string {
  return context.asAbsolutePath(path.join('resources', 'proto', 'emulator_controller.proto'));
}

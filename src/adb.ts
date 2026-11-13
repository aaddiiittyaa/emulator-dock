import { ChildProcess, execFile, spawn } from 'child_process';

/** One line of `adb devices -l`. */
export interface AdbDevice {
  serial: string;
  /** "device" when usable; otherwise "unauthorized", "offline", "no permissions", "authorizing"... */
  state: string;
  model?: string;
  product?: string;
  /** Present for USB connections, e.g. "1-1". */
  usb?: string;
}

/** Details read from a connected device's system properties. */
export interface AdbDeviceInfo {
  name: string;
  sdk: number;
}

export function isEmulatorSerial(serial: string): boolean {
  return /^emulator-\d+$/.test(serial);
}

/** Wireless debugging serials: "192.168.1.5:5555" or mDNS names like "adb-XXXX._adb-tls-connect._tcp". */
export function isNetworkSerial(serial: string): boolean {
  return /:\d+$/.test(serial) || serial.includes('._adb-tls-');
}

export function parseDeviceList(text: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('List of devices') || line.startsWith('*')) {
      continue;
    }
    const match = /^(\S+)\s+(no permissions|\S+)(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const device: AdbDevice = { serial: match[1], state: match[2] };
    for (const [, key, value] of match[3].matchAll(/\b(usb|product|model):(\S+)/g)) {
      device[key as 'usb' | 'product' | 'model'] = value;
    }
    devices.push(device);
  }
  return devices;
}

/** Runs adb and resolves with its raw stdout; rejects with adb's own error text. */
export function adbExec(adb: string, args: string[], timeoutMs = 10000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      adb,
      args,
      { encoding: 'buffer', timeout: timeoutMs, maxBuffer: 128 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.toString('utf8').trim() || error.message));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

export async function adbShell(adb: string, serial: string, command: string, timeoutMs = 10000): Promise<string> {
  return (await adbExec(adb, ['-s', serial, 'shell', command], timeoutMs)).toString('utf8');
}

const INFO_PROPS = [
  'ro.product.manufacturer',
  'ro.product.model',
  'ro.build.version.sdk',
  'ro.boot.qemu.avd_name',
  // Marketing names ("OnePlus 15R", "Redmi Note 13") where vendors publish one.
  'ro.product.marketname',
  'ro.product.vendor.marketname',
  'ro.product.odm.marketname',
  'ro.vendor.oplus.market.name',
  'ro.config.marketing_name',
];

export async function readDeviceInfo(adb: string, serial: string): Promise<AdbDeviceInfo | undefined> {
  let out: string;
  try {
    out = await adbShell(adb, serial, INFO_PROPS.map((p) => `getprop ${p}`).join('; '), 8000);
  } catch {
    return undefined;
  }
  const [manufacturer = '', model = '', sdk = '', avdName = '', ...marketNames] = out.split('\n').map((l) => l.trim());
  let name = avdName ? avdName.replace(/_/g, ' ') : marketNames.find(Boolean) ?? '';
  if (!name && model) {
    const brand = manufacturer ? manufacturer[0].toUpperCase() + manufacturer.slice(1) : '';
    name = brand && !model.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${model}` : model;
  }
  return { name: name || serial, sdk: Number(sdk) || 0 };
}

/**
 * Follows `adb track-devices -l`, which pushes the full device list whenever a device is
 * plugged in, unplugged, authorized or goes offline. Restarts (and with it the adb server)
 * with backoff if adb exits.
 */
export class AdbDeviceTracker {
  private child: ChildProcess | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private backoffMs = 1000;
  private disposed = false;

  constructor(
    readonly adb: string,
    private readonly onDevices: (devices: AdbDevice[]) => void,
    private readonly log: (message: string) => void,
  ) {
    this.start();
  }

  private start(): void {
    let child: ChildProcess;
    try {
      child = spawn(this.adb, ['track-devices', '-l'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      this.onExit(`could not start adb: ${(e as Error).message}`);
      return;
    }
    this.child = child;
    let pending: Buffer = Buffer.alloc(0);
    let stderr = '';
    let finished = false;
    child.stdout!.on('data', (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      // Each update is a 4-digit hex length followed by that many bytes of `adb devices -l` output.
      while (pending.length >= 4) {
        const length = parseInt(pending.toString('latin1', 0, 4), 16);
        if (Number.isNaN(length)) {
          this.log(`Unexpected output from adb track-devices: ${pending.toString('latin1', 0, 80)}`);
          child.kill();
          return;
        }
        if (pending.length < 4 + length) {
          break;
        }
        const text = pending.toString('utf8', 4, 4 + length);
        pending = pending.subarray(4 + length);
        this.backoffMs = 1000;
        this.onDevices(parseDeviceList(text));
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2000);
    });
    const finish = (reason: string) => {
      if (finished) {
        return;
      }
      finished = true;
      if (this.child === child) {
        this.child = undefined;
        this.onExit(reason);
      }
    };
    child.on('error', (err) => finish(err.message));
    child.on('close', (code, signal) => finish(`${signal ?? `exit code ${code}`}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
  }

  private onExit(reason: string): void {
    if (this.disposed) {
      return;
    }
    this.onDevices([]);
    this.log(`adb device tracking stopped (${reason}); retrying in ${this.backoffMs / 1000}s`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.start();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, 30000);
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.restartTimer);
    this.child?.kill();
    this.child = undefined;
  }
}

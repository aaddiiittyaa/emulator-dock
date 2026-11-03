import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const isWindows = process.platform === 'win32';

export interface AvdInfo {
  /** AVD identifier, as passed to `emulator -avd`. */
  id: string;
  /** Human-friendly name from the AVD's config.ini, falling back to the id. */
  displayName: string;
}

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function defaultSdkLocations(): string[] {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return [path.join(home, 'Library', 'Android', 'sdk')];
    case 'win32':
      return [path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Android', 'Sdk')];
    default:
      return [path.join(home, 'Android', 'Sdk'), path.join(home, 'Android', 'sdk'), '/opt/android-sdk'];
  }
}

/** Finds the Android SDK. Returns undefined if no usable SDK (one with the emulator package) exists. */
export function resolveSdkPath(configured: string | undefined): string | undefined {
  const candidates = [
    configured?.trim() ? expandHome(configured.trim()) : undefined,
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    ...defaultSdkLocations(),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(emulatorBinary(candidate))) {
      return candidate;
    }
  }
  return undefined;
}

export function emulatorBinary(sdk: string): string {
  return path.join(sdk, 'emulator', isWindows ? 'emulator.exe' : 'emulator');
}

function avdHome(): string {
  if (process.env.ANDROID_AVD_HOME) {
    return process.env.ANDROID_AVD_HOME;
  }
  const userHome = process.env.ANDROID_USER_HOME ?? process.env.ANDROID_EMULATOR_HOME ?? path.join(os.homedir(), '.android');
  return path.join(userHome, 'avd');
}

function readIni(file: string): Record<string, string> {
  const result: Record<string, string> = {};
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return result;
  }
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0) {
      result[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }
  return result;
}

function displayNameFor(id: string): string {
  const pointer = readIni(path.join(avdHome(), `${id}.ini`));
  const avdDir = pointer['path'] ?? path.join(avdHome(), `${id}.avd`);
  const config = readIni(path.join(avdDir, 'config.ini'));
  return config['avd.ini.displayname'] || id.replace(/_/g, ' ');
}

/** Lists the AVDs the emulator knows about, using `emulator -list-avds` as the source of truth. */
export function listAvds(sdk: string): Promise<AvdInfo[]> {
  return new Promise((resolve) => {
    execFile(emulatorBinary(sdk), ['-list-avds'], { timeout: 15000 }, (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }
      const ids = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        // The emulator sometimes prints log lines ("INFO | ...") alongside the names.
        .filter((l) => /^[A-Za-z0-9._-]+$/.test(l));
      resolve(ids.map((id) => ({ id, displayName: displayNameFor(id) })));
    });
  });
}

export interface LaunchOptions {
  hideWindow: boolean;
  extraArgs: string[];
  logFile: string;
  /** Let the emulator shut itself down after this many seconds without any gRPC client. */
  idleTimeoutSec?: number;
}

/**
 * Starts an AVD. Output goes to a log file rather than a pipe so the emulator keeps
 * running safely if the extension host goes away.
 */
export function launchEmulator(sdk: string, avdId: string, options: LaunchOptions) {
  fs.mkdirSync(path.dirname(options.logFile), { recursive: true });
  const fd = fs.openSync(options.logFile, 'a');
  const args = ['-avd', avdId, '-grpc-use-token'];
  if (options.hideWindow) {
    args.push('-qt-hide-window');
  }
  if (options.idleTimeoutSec) {
    args.push('-idle-grpc-timeout', String(options.idleTimeoutSec));
  }
  args.push(...options.extraArgs);
  const child = spawn(emulatorBinary(sdk), args, {
    cwd: path.join(sdk, 'emulator'),
    detached: !isWindows,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  fs.closeSync(fd);
  child.unref();
  return { child, args };
}

export function adbBinary(sdk: string): string {
  return path.join(sdk, 'platform-tools', isWindows ? 'adb.exe' : 'adb');
}

/**
 * Reads the screen's rounded-corner radius (native pixels) from Android itself. SystemUI
 * paints these corners black into every frame, so the panel must clip to the same radius.
 * Resolves to the radius, `null` when the device reports no rounded corners (or predates
 * Android 12), or `undefined` when adb couldn't answer yet (device still booting, no adb).
 */
export function readCornerRadius(sdk: string, serial: string): Promise<number | null | undefined> {
  return new Promise((resolve) => {
    execFile(
      adbBinary(sdk),
      ['-s', serial, 'shell', 'dumpsys', 'display'],
      { timeout: 8000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error || !/DisplayInfo/.test(stdout)) {
          resolve(undefined);
          return;
        }
        const match = /RoundedCorner\{position=TopLeft, radius=(\d+)/.exec(stdout);
        resolve(match ? Number(match[1]) : null);
      },
    );
  });
}

export function tailFile(file: string, lines: number): string {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split(/\r?\n/).slice(-lines).join('\n').trim();
  } catch {
    return '';
  }
}

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** A running emulator, as advertised in its registration (`pid_<pid>.ini`) file. */
export interface RunningEmulator {
  pid: number;
  avdId: string;
  avdName: string;
  grpcPort: number;
  grpcToken?: string;
  /** Console port, e.g. 5554. The adb serial is `emulator-<serialPort>`. */
  serialPort: number;
  /**
   * Seconds of gRPC silence after which the emulator shuts itself down (`-idle-grpc-timeout`),
   * if it was launched with one. Such emulators must be pinged to stay alive.
   */
  idleTimeoutSec?: number;
}

/**
 * Directory where every running emulator writes a registration file. This mirrors the
 * lookup Android Studio uses, so emulators started from anywhere are found.
 */
export function registrationDirectory(): string {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Caches', 'TemporaryItems', 'avd', 'running');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Temp', 'avd', 'running');
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  for (const dir of [process.env.XDG_RUNTIME_DIR, uid !== undefined ? `/run/user/${uid}` : undefined]) {
    if (dir && fs.existsSync(dir)) {
      return path.join(dir, 'avd', 'running');
    }
  }
  return path.join(os.tmpdir(), `android-${os.userInfo().username}`, 'avd', 'running');
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Extracts `-idle-grpc-timeout <n>` from the quoted command line in a registration file. */
export function parseIdleTimeout(cmdline: string | undefined): number | undefined {
  const match = cmdline ? /-idle-grpc-timeout"?\s+"?(\d+)/.exec(cmdline) : null;
  return match ? Number(match[1]) : undefined;
}

function parse(text: string): Record<string, string> {
  const kv: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0) {
      kv[line.slice(0, eq)] = line.slice(eq + 1);
    }
  }
  return kv;
}

export async function discoverRunningEmulators(): Promise<RunningEmulator[]> {
  const dir = registrationDirectory();
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const result: RunningEmulator[] = [];
  for (const name of names) {
    const match = /^pid_(\d+)\.ini$/.exec(name);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    if (!isAlive(pid)) {
      continue;
    }
    let kv: Record<string, string>;
    try {
      kv = parse(await fs.promises.readFile(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    const grpcPort = Number(kv['grpc.port']);
    if (!grpcPort) {
      // gRPC not up yet (the file is written in stages) or disabled; skip for now.
      continue;
    }
    result.push({
      pid,
      avdId: kv['avd.id'] ?? kv['avd.name'] ?? `emulator-${kv['port.serial']}`,
      avdName: kv['avd.name'] ?? kv['avd.id'] ?? 'Emulator',
      grpcPort,
      grpcToken: kv['grpc.token'] || undefined,
      serialPort: Number(kv['port.serial']) || 0,
      idleTimeoutSec: parseIdleTimeout(kv['cmdline']),
    });
  }
  result.sort((a, b) => a.serialPort - b.serialPort);
  return result;
}

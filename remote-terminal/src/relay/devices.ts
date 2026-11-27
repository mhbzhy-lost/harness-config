/**
 * 可信设备存储：devices.json / pair-pending.json 的锁协议读写与批准/吊销逻辑。
 * 所有运行时文件均保存在 stateDir（默认 ~/.harness-remote/），权限 0600。
 */
import { randomUUID } from "node:crypto";
import { appendFile, link, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { PAIR_TTL_MS } from "../protocol.ts";

export type DeviceRecord = {
  id: string;
  name: string;
  ua: string;
  secretHash: string;
  approvedAt: string;
};

export type PendingRecord = {
  id: string;
  code: string;
  ua: string;
  ip: string;
  secretHash: string;
  ts: number;
  status: "pending" | "denied";
};

export function devicesPath(stateDir: string): string {
  return path.join(stateDir, "devices.json");
}

export function pendingPath(stateDir: string): string {
  return path.join(stateDir, "pair-pending.json");
}

export function lastSeenPath(stateDir: string): string {
  return path.join(stateDir, "devices-lastseen.json");
}

async function readJsonArray<T>(file: string): Promise<T[]> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`设备存储文件损坏（${path.basename(file)}）：请人工检查后再试`);
  }
}

async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type LockPayload = { pid: number; token: string | null };

function parseLockPayload(raw: string): LockPayload | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as { pid?: unknown; token?: unknown };
    if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      const token = typeof parsed.token === "string" && parsed.token.length > 0 ? parsed.token : null;
      return { pid: parsed.pid, token };
    }
  } catch {
    if (/^\d+$/.test(trimmed)) {
      const pid = Number.parseInt(trimmed, 10);
      if (Number.isInteger(pid) && pid > 0) return { pid, token: null };
    }
  }
  return null;
}

async function writeLockTemp(lockFile: string, payload: { pid: number; token: string }): Promise<{ tmpPath: string; ino: number | bigint }> {
  const tmpPath = `${lockFile}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(tmpPath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(payload));
    const st = await handle.stat();
    return { tmpPath, ino: st.ino };
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  } finally {
    await handle.close();
  }
}

async function tryReclaimStaleLock(lockFile: string): Promise<boolean> {
  let st: Awaited<ReturnType<typeof lstat>>;
  let raw: string;
  try {
    st = await lstat(lockFile);
    raw = await readFile(lockFile, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }

  const observed = parseLockPayload(raw);
  const hasToken = observed !== null && observed.token !== null;
  const isDead = observed === null || !pidAlive(observed.pid);
  const graceExpired = Date.now() - st.mtimeMs > 2_000;
  if (!isDead || (!hasToken && !graceExpired)) return false;

  const reclaimFile = `${lockFile}.reclaim`;
  const { tmpPath: reclaimTmp, ino: reclaimIno } = await writeLockTemp(reclaimFile, {
    pid: process.pid,
    token: randomUUID(),
  });
  try {
    await link(reclaimTmp, reclaimFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      const rSt = await lstat(reclaimFile);
      const rRaw = await readFile(reclaimFile, "utf8");
      const rObserved = parseLockPayload(rRaw);
      if ((rObserved === null || !pidAlive(rObserved.pid)) && Date.now() - rSt.mtimeMs > 5_000) {
        await unlink(reclaimFile).catch(() => {});
      }
    } catch {
      // 忽略
    }
    return false;
  } finally {
    await unlink(reclaimTmp).catch(() => {});
  }

  try {
    const curSt = await lstat(lockFile);
    const curRaw = await readFile(lockFile, "utf8");
    const cur = parseLockPayload(curRaw);
    if (curSt.ino === st.ino) {
      const stillDead = hasToken
        ? cur !== null && cur.token === observed!.token && !pidAlive(cur.pid)
        : (cur === null || (cur.token === null && !pidAlive(cur.pid))) && Date.now() - curSt.mtimeMs > 2_000;
      if (stillDead) {
        await unlink(lockFile).catch(() => {});
        return true;
      }
    }
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  } finally {
    try {
      const curReclaimSt = await lstat(reclaimFile);
      if (curReclaimSt.ino === reclaimIno) await unlink(reclaimFile);
    } catch {
      // 忽略
    }
  }
}

/** 使用临时文件 + link 原子发布与 .reclaim 互斥回收协议的跨进程文件锁 */
export async function withFileLock<T>(
  stateDir: string,
  lockName: string,
  options: { timeoutMs: number; pollMs: number; timeoutMessage: string },
  fn: () => Promise<T>,
): Promise<T> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lockFile = path.join(stateDir, lockName);
  const { tmpPath, ino: myIno } = await writeLockTemp(lockFile, { pid: process.pid, token: randomUUID() });
  const deadline = Date.now() + options.timeoutMs;

  try {
    for (;;) {
      try {
        await link(tmpPath, lockFile);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await tryReclaimStaleLock(lockFile)) continue;
        if (Date.now() > deadline) throw new Error(options.timeoutMessage);
        await new Promise((resolve) => setTimeout(resolve, options.pollMs));
      }
    }
  } finally {
    await unlink(tmpPath).catch(() => {});
  }

  try {
    return await fn();
  } finally {
    try {
      const st = await lstat(lockFile);
      if (st.ino === myIno) await unlink(lockFile);
    } catch {
      // 忽略
    }
  }
}

export async function withDeviceLock<T>(stateDir: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(
    stateDir,
    "devices.lock",
    {
      timeoutMs: 5_000,
      pollMs: 50,
      timeoutMessage: "设备存储锁等待超时：可能有其他 rtctl 命令正在执行，请稍后重试",
    },
    fn,
  );
}

export async function readDevices(stateDir: string): Promise<DeviceRecord[]> {
  return readJsonArray<DeviceRecord>(devicesPath(stateDir));
}

export async function readPending(stateDir: string): Promise<PendingRecord[]> {
  return readJsonArray<PendingRecord>(pendingPath(stateDir));
}

export function isPendingAlive(record: PendingRecord, now = Date.now()): boolean {
  return now - record.ts < PAIR_TTL_MS;
}

export async function readActivePending(stateDir: string, now = Date.now()): Promise<PendingRecord[]> {
  return (await readPending(stateDir)).filter((p) => p.status === "pending" && isPendingAlive(p, now));
}

export async function readLastSeen(stateDir: string): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(lastSeenPath(stateDir), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export async function audit(stateDir: string, line: string): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await appendFile(path.join(stateDir, "audit.log"), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
}

function locateByCode(pending: PendingRecord[], code: string): PendingRecord {
  const matches = pending.filter((p) => p.code === code && p.status === "pending" && isPendingAlive(p));
  if (matches.length === 0) throw new Error(`没有配对码 ${code} 对应的待批准设备（可能已过期或已处理）`);
  if (matches.length > 1) throw new Error(`配对码 ${code} 命中多条待批准记录（碰撞），请让设备重新配对后再批准`);
  return matches[0]!;
}

export async function approveByCode(stateDir: string, code: string, name?: string): Promise<DeviceRecord> {
  return withDeviceLock(stateDir, async () => {
    const pending = await readPending(stateDir);
    const target = locateByCode(pending, code);
    const devices = await readDevices(stateDir);
    let device = devices.find((d) => d.id === target.id);
    if (!device) {
      device = {
        id: target.id,
        name: name?.trim() || target.ua.slice(0, 60) || "未命名设备",
        ua: target.ua,
        secretHash: target.secretHash,
        approvedAt: new Date().toISOString(),
      };
      devices.push(device);
      await atomicWriteJson(devicesPath(stateDir), devices);
    }
    await atomicWriteJson(pendingPath(stateDir), pending.filter((p) => p.id !== target.id));
    await audit(stateDir, `approve id=${device.id} name=${device.name} code=${code} ua=${target.ua} ip=${target.ip}`);
    return device;
  });
}

export async function denyByCode(stateDir: string, code: string): Promise<PendingRecord> {
  return withDeviceLock(stateDir, async () => {
    const pending = await readPending(stateDir);
    const target = locateByCode(pending, code);
    target.status = "denied";
    await atomicWriteJson(pendingPath(stateDir), pending);
    await audit(stateDir, `deny id=${target.id} code=${code} ua=${target.ua} ip=${target.ip}`);
    return target;
  });
}

export async function revokeById(stateDir: string, id: string): Promise<DeviceRecord> {
  return withDeviceLock(stateDir, async () => {
    const devices = await readDevices(stateDir);
    const device = devices.find((d) => d.id === id);
    if (!device) throw new Error(`没有 id 为 ${id} 的可信设备`);
    await atomicWriteJson(devicesPath(stateDir), devices.filter((d) => d.id !== id));
    await audit(stateDir, `revoke id=${id} name=${device.name}`);
    return device;
  });
}

export async function addPending(stateDir: string, record: PendingRecord): Promise<void> {
  await withDeviceLock(stateDir, async () => {
    const pending = (await readPending(stateDir)).filter((p) => isPendingAlive(p) && p.id !== record.id);
    pending.push(record);
    await atomicWriteJson(pendingPath(stateDir), pending);
  });
  await audit(stateDir, `pair-request id=${record.id} code=${record.code} ua=${record.ua} ip=${record.ip}`);
}

export async function clearStalePending(stateDir: string): Promise<void> {
  await withDeviceLock(stateDir, async () => {
    const pending = await readPending(stateDir);
    const kept = pending.filter((p) => p.status === "denied" && isPendingAlive(p));
    if (kept.length !== pending.length) await atomicWriteJson(pendingPath(stateDir), kept);
  });
}

export async function writeLastSeen(stateDir: string, map: Record<string, string>): Promise<void> {
  await atomicWriteJson(lastSeenPath(stateDir), map);
}

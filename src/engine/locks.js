import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isAlive, sleep } from './proc.js';

export class LockBusy extends Error {
  constructor(resource, owner) { super(`resource ${resource} is busy (held by ${owner})`); this.resource = resource; this.owner = owner; }
}

function lockFile(home, resource) {
  const name = resource === 'instance' ? 'instance' : crypto.createHash('sha1').update(resource).digest('hex');
  return path.join(home, 'locks', `${name}.json`);
}

function tryTake(home, resource, owner) {
  const file = lockFile(home, resource);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(file, JSON.stringify({ resource, owner, pid: process.pid, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    return null;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let cur;
    try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { cur = null; }
    if (!cur || !isAlive(cur.pid)) { try { fs.unlinkSync(file); } catch { /* raced */ } return { stale: true }; }
    return cur;
  }
}

export async function acquire(home, resource, { owner, waitMs = 600_000, pollMs = 1000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const holder = tryTake(home, resource, owner);
    if (!holder) return;
    if (holder.stale) continue;
    if (Date.now() - t0 >= waitMs) throw new LockBusy(resource, holder.owner);
    await sleep(pollMs);
  }
}

export function release(home, resource, owner) {
  const file = lockFile(home, resource);
  try {
    const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cur.owner === owner && cur.pid === process.pid) fs.unlinkSync(file);
  } catch { /* already gone */ }
}

export function instanceLock(home) {
  for (;;) {
    const holder = tryTake(home, 'instance', 'panel');
    if (!holder) return { release: () => release(home, 'instance', 'panel') };
    if (holder.stale) continue;
    throw new LockBusy('instance', `pid ${holder.pid}`);
  }
}

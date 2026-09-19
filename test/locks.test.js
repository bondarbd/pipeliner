import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquire, release, instanceLock, LockBusy } from '../src/engine/locks.js';

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rb-lock-'));

test('acquire/release and busy wait timeout', async () => {
  const h = home();
  await acquire(h, 'repo:/a', { owner: 'run1' });
  await assert.rejects(acquire(h, 'repo:/a', { owner: 'run2', waitMs: 300, pollMs: 50 }), (e) => e instanceof LockBusy && e.owner === 'run1');
  release(h, 'repo:/a', 'run1');
  await acquire(h, 'repo:/a', { owner: 'run2', waitMs: 100 });
  release(h, 'repo:/a', 'run2');
});

test('stale lock of a dead pid is reclaimed', async () => {
  const h = home();
  fs.mkdirSync(path.join(h, 'locks'), { recursive: true });
  const f = path.join(h, 'locks', 'instance.json');
  fs.writeFileSync(f, JSON.stringify({ resource: 'instance', owner: 'old', pid: 999999, at: 'x' }));
  const lock = instanceLock(h);
  assert.throws(() => instanceLock(h), LockBusy);
  lock.release();
  instanceLock(h).release();
});

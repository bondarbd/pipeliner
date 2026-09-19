import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export async function killGroup(pid, graceMs = 10_000) {
  if (!pid) return;
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { return; } }
  const t0 = Date.now();
  while (Date.now() - t0 < graceMs) { if (!isAlive(pid)) return; await sleep(100); }
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

export function runProcess({ argv, shellCmd, cwd, env, timeout, logPath, masker, maxBytes = 5_000_000, onSpawn, tailBytes = 65_536 }) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const log = fs.createWriteStream(logPath, { flags: 'a', mode: 0o600 });
    const cmd = argv ? argv[0] : 'bash';
    const args = argv ? argv.slice(1) : ['-c', shellCmd];
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { log.end(); return reject(e); }
    child.on('error', (e) => { log.end(() => resolve({ code: 127, signal: null, timedOut: false, tail: String(e.message), pid: child.pid })); });
    onSpawn?.(child.pid);
    let tail = '';
    let written = 0;
    let truncated = false;
    const capture = (chunk) => {
      const s = masker ? masker.mask(chunk.toString()) : chunk.toString();
      tail = (tail + s).slice(-tailBytes);
      if (written + s.length <= maxBytes) { log.write(s); written += s.length; }
      else if (!truncated) { truncated = true; log.write(`\n[runboard: log truncated at ${maxBytes} bytes]\n`); }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    let timedOut = false;
    const timer = timeout ? setTimeout(() => { timedOut = true; killGroup(child.pid); }, timeout * 1000) : null;
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      log.end(() => resolve({ code, signal, timedOut, tail, pid: child.pid }));
    });
  });
}

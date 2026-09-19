import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcess, isAlive } from '../src/engine/proc.js';
import { createMasker } from '../src/secrets.js';

const log = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rb-proc-')), 'x.log');

test('runs a shell command, captures tail and masks log', async () => {
  const logPath = log();
  const r = await runProcess({ shellCmd: 'echo token=abcdef123; echo err >&2; exit 3', cwd: os.tmpdir(), env: { PATH: process.env.PATH }, logPath, masker: createMasker(['abcdef123']) });
  assert.equal(r.code, 3);
  assert.match(r.tail, /token=\*\*\*/);
  assert.match(fs.readFileSync(logPath, 'utf8'), /token=\*\*\*[\s\S]*err/);
});

test('timeout kills the whole process group', async () => {
  const logPath = log();
  let pid;
  const r = await runProcess({ shellCmd: 'sleep 30 & sleep 30; echo never', cwd: os.tmpdir(), env: { PATH: process.env.PATH }, timeout: 1, logPath, onSpawn: (p) => { pid = p; } });
  assert.equal(r.timedOut, true);
  assert.ok(pid > 0);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(isAlive(pid), false);
  assert.doesNotMatch(r.tail, /never/);
});

test('argv form and log truncation', async () => {
  const logPath = log();
  const r = await runProcess({ argv: ['bash', '-c', 'yes | head -c 5000'], cwd: os.tmpdir(), env: { PATH: process.env.PATH }, logPath, maxBytes: 1000 });
  assert.equal(r.code, 0);
  const text = fs.readFileSync(logPath, 'utf8');
  assert.ok(text.length < 1200);
  assert.match(text, /\[runboard: log truncated/);
});

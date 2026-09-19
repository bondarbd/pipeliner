import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import * as agent from '../src/runners/agent.js';
import { createMasker } from '../src/secrets.js';

const FAKE = path.resolve('test/fixtures/fake-agent.sh');

function rctx(mode, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-agent-'));
  execSync('git init -q && git commit -q --allow-empty -m init', { cwd: dir });
  const outDir = path.join(dir, 'out'); fs.mkdirSync(outDir);
  const ctxDir = path.join(dir, 'ctx'); fs.mkdirSync(ctxDir);
  let calls = 0;
  return {
    calls: () => calls,
    run: { id: 'r1' }, item: { name: 'p1', dir }, config: { agent: { command: [FAKE, '-p', '{prompt}'], readonly_command: [FAKE, '-p', '{prompt}', '--mode', 'ro'], timeout: 60 }, logs: {} },
    exprCtx: { item: { name: 'p1', dir, steps: { branch: { commit: 'abc' } } }, run: { params: { n: '7' }, steps: {} } },
    env: { FAKE_AGENT_MODE: mode }, cwd: dir, outDir, logPath: path.join(dir, 'a.log'), timeout: 5, masker: createMasker([]),
    notes: 'earlier note', pilotNotes: null, templateDir: dir, itemCtxDir: ctxDir, runCtxDir: ctxDir,
    onSpawn() {}, countAgentCall() { calls++; }, ...over,
  };
}

test('happy path: prompt contains body, context, previous steps and input; output parsed; diff snapshot written', async () => {
  const r = rctx('keys');
  const res = await agent.run({ name: 'a', agent: { prompt: 'Do ${{ item.name }} for ${{ run.params.n }}', input: '${{ item.steps.branch }}' } }, r);
  assert.equal(res.ok, true);
  assert.deepEqual(res.output, { result: 'ok' });
  const seen = fs.readFileSync(path.join(r.outDir, 'seen-prompt.txt'), 'utf8');
  assert.match(seen, /^Do p1 for 7/);
  assert.match(seen, /<notes>\nearlier note\n<\/notes>/);
  assert.match(seen, /<previous_steps>[\s\S]*"commit": "abc"/);
  assert.match(seen, /<input>[\s\S]*"commit": "abc"/);
  assert.match(seen, /NEED_INPUT=/);
  assert.match(seen, new RegExp(r.outDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(fs.existsSync(path.join(r.outDir, 'prompt.md')));
  assert.ok(fs.existsSync(r.logPath.replace(/\.log$/, '.diff')));
  assert.equal(r.calls(), 1);
});

test('format error triggers one repair call; readonly uses readonly_command; pilot notes included', async () => {
  const r = rctx('badformat', { pilotNotes: 'pilot did Y' });
  const res = await agent.run({ name: 'a', agent: { prompt: 'x', readonly: true } }, r);
  assert.equal(res.ok, true);
  assert.equal(res.output.fixed, '1');
  assert.equal(r.calls(), 2);
  const seen = fs.readFileSync(path.join(r.outDir, 'seen-prompt.txt'), 'utf8');
  assert.match(seen, /<pilot_notes>\npilot did Y/);
  assert.match(fs.readFileSync(r.logPath, 'utf8'), /--mode ro|fake-agent/);
});

test('NEED_INPUT is surfaced; dirty tree before start is refused; dirty after kill is flagged', async () => {
  const n = rctx('needinput');
  assert.deepEqual((await agent.run({ name: 'a', agent: { prompt: 'x' } }, n)).needInput, 'which version?');

  const d = rctx('keys');
  fs.writeFileSync(path.join(d.cwd, 'dirty.txt'), 'x');
  const refused = await agent.run({ name: 'a', agent: { prompt: 'x' } }, d);
  assert.equal(refused.ok, false); assert.match(refused.error, /dirty before agent/);

  const k = rctx('dirty', { timeout: 1 });
  const killed = await agent.run({ name: 'a', agent: { prompt: 'x' } }, k);
  assert.equal(killed.ok, false); assert.equal(killed.dirtyAfterKill, true);
});

test('spawn failure is reported directly, without a repair call', async () => {
  const r = rctx('keys', { config: { agent: { command: ['/nonexistent/agent', '-p', '{prompt}'], readonly_command: ['/nonexistent/agent', '-p', '{prompt}'], timeout: 60 }, logs: {} } });
  const res = await agent.run({ name: 'a', agent: { prompt: 'x' } }, r);
  assert.equal(res.ok, false);
  assert.match(res.error, /spawn error|ENOENT|exited 127/);
  assert.equal(r.calls(), 1);
});

test('{prompt} substitution does not interpret $-patterns from the prompt body', async () => {
  const r = rctx('keys');
  const res = await agent.run({ name: 'a', agent: { prompt: 'body with $& and $1 inside' } }, r);
  assert.equal(res.ok, true);
  const seen = fs.readFileSync(path.join(r.outDir, 'seen-prompt.txt'), 'utf8');
  assert.match(seen, /^body with \$& and \$1 inside/);
});

test('prompt is capped even with a very large input', async () => {
  const r = rctx('keys');
  const big = 'x'.repeat(200_000);
  const res = await agent.run({ name: 'a', agent: { prompt: 'short body', input: big } }, r);
  assert.equal(res.ok, true);
  const seen = fs.readFileSync(path.join(r.outDir, 'seen-prompt.txt'), 'utf8');
  assert.ok(seen.length < 110_000, `prompt too long: ${seen.length}`);
  assert.match(seen, /\[truncated/);
});

test('a git failure (not just "not a repo") fails closed before launching the agent', async () => {
  const r = rctx('keys');
  fs.writeFileSync(path.join(r.cwd, '.git', 'index'), 'garbage');
  const res = await agent.run({ name: 'a', agent: { prompt: 'x' } }, r);
  assert.equal(res.ok, false);
  assert.match(res.error, /git check failed/);
  assert.equal(r.calls(), 0);
});

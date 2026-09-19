import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkEngine } from './helpers.js';
import { Engine } from '../src/engine/run.js';
import { loadRun } from '../src/engine/store.js';
import * as locks from '../src/engine/locks.js';

const fail = { ok: false, error: 'boom' };
const okr = { ok: true, output: {} };

test('check short-circuits the body; verify failure makes the cell unverified and applies the ladder', async () => {
  const { engine, run, fake } = mkEngine({ items: [{ name: 'a' }, { name: 'b' }],
    steps: [{ name: 's', each: true, shell: 'x', check: 'c', verify: 'v' }],
    plan: { 'a:s#check': { ok: true, output: { commit: 'old' } }, 'b:s#check': fail, 'b:s': { ok: true, output: { commit: 'new' } }, 'b:s#verify': fail } });
  engine.start(); await engine.idle();
  assert.deepEqual(run.cells.a.s.output, { commit: 'old' });
  assert.ok(!fake.calls.includes('a:s'));
  assert.equal(run.cells.b.s.status, 'paused');
  assert.match(run.cells.b.s.error, /verify failed/);
  assert.ok(run.history.some((e) => e.type === 'cell.unverified' && e.item === 'b'));
});

test('resource lock serialises steps on the same resource across engines', async () => {
  let inside = 0, peak = 0;
  const slow = async () => { inside++; peak = Math.max(peak, inside); await new Promise((r) => setTimeout(r, 30)); inside--; return { ok: true, output: {} }; };
  const a = mkEngine({ items: [{ name: 'p' }], steps: [{ name: 's', each: true, shell: 'x', resource: 'repo:${{ item.name }}' }], plan: { 'p:s': slow } });
  const b = mkEngine({ items: [{ name: 'p' }], steps: [{ name: 's', each: true, shell: 'x', resource: 'repo:${{ item.name }}' }], plan: { 'p:s': slow } });
  b.cfg.home = a.cfg.home;                       // share the lock dir
  a.engine.start(); b.engine.start();
  await Promise.all([a.engine.idle(), b.engine.idle()]);
  assert.equal(peak, 1);
  assert.equal(fs.readdirSync(path.join(a.cfg.home, 'locks')).length, 0);
});

test('agent-call budget and run timeout pause the run with a note', async () => {
  const { engine, run } = mkEngine({ items: [{ name: 'a' }, { name: 'b' }],
    steps: [{ name: 's', each: true, agent: { prompt: 'p' }, verify: 'true' }],
    plan: { 'a:s': (step, r) => { r.countAgentCall(); return { ok: true, output: {} }; }, 'b:s': (step, r) => { r.countAgentCall(); return { ok: true, output: {} }; } },
    config: { limits: { max_agent_calls: 1, parallel: 1 } } });
  engine.start(); await engine.idle();
  assert.equal(run.pausedByUser, true);
  assert.match(run.note, /max_agent_calls/);
  assert.equal(run.cells.b.s.status, 'pending');

  engine.resumeRun(); await engine.idle();
  assert.equal(run.cells.b.s.status, 'success');
  assert.equal(run.pausedByUser, false);

  const t = mkEngine({ items: [{ name: 'a' }], steps: [{ name: 's', each: true, shell: 'x' }], config: { limits: { run_timeout: 0 } } });
  t.run.budgets.since = new Date(Date.now() - 5000).toISOString();
  t.engine.start(); await t.engine.idle();
  assert.match(t.run.note, /run_timeout/);
  t.engine.resumeRun(); await t.engine.idle();
  assert.equal(t.run.cells.a.s.status, 'success');
});

test('resource lock busy pauses the cell without spending an attempt; releasing the lock lets a retry succeed', async () => {
  const { engine, run, cfg } = mkEngine({ items: [{ name: 'p' }],
    steps: [{ name: 's', each: true, shell: 'x', resource: 'repo:${{ item.name }}' }],
    plan: { 'p:s': okr }, config: { limits: { lock_wait: 0 } } });
  await locks.acquire(cfg.home, 'repo:p', { owner: 'other' });
  engine.start(); await engine.idle();
  assert.equal(run.cells.p.s.status, 'paused');
  assert.match(run.cells.p.s.error, /busy/);
  assert.equal(run.cells.p.s.attempts, 0);
  locks.release(cfg.home, 'repo:p', 'other');
  engine.retry('p', 's'); await engine.idle();
  assert.equal(run.cells.p.s.status, 'success');
});

test('recover: running cells become interrupted, check can confirm them, no auto retry otherwise', async () => {
  const first = mkEngine({ items: [{ name: 'a' }, { name: 'b' }],
    steps: [{ name: 's', each: true, shell: 'x', check: 'c' }, { name: 't', each: true, shell: 'y' }],
    plan: { 'a:s#check': fail, 'b:s#check': fail, 'a:s': () => new Promise(() => {}), 'b:s': () => new Promise(() => {}) } });
  first.engine.start();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(first.run.cells.a.s.status, 'running');
  // simulate a restart: a fresh engine over the persisted run.json
  const run = loadRun(first.home, first.run.id);
  const { fakeRunner } = await import('../src/runners/fake.js');
  const fake = fakeRunner({ 'a:s#check': { ok: true, output: { done: '1' } }, 'b:s#check': fail });
  const second = new Engine({ run, config: first.cfg, runners: { shell: fake, js: fake, agent: fake, human: first.runners.human }, sleep: () => Promise.resolve() });
  await second.recover(); await second.idle();
  assert.equal(run.cells.a.s.status, 'success');
  assert.equal(run.cells.a.t.status, 'success');
  assert.equal(run.cells.b.s.status, 'interrupted');
  assert.match(run.cells.b.s.error, /restart/);
  assert.ok(!fake.calls.includes('b:s'));
  assert.ok(run.history.some((e) => e.type === 'run.recovered'));
  second.retry('b', 's'); await second.idle();
  assert.equal(run.cells.b.s.status, 'success');
});

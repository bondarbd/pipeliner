import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkEngine } from './helpers.js';
import { loadRun } from '../src/engine/store.js';

const fail = { ok: false, error: 'boom' };
const okr = { ok: true, output: { v: 1 } };

test('retry rung: retries N times then next rung (pause)', async () => {
  const { engine, run, fake } = mkEngine({ items: [{ name: 'a' }],
    steps: [{ name: 's', each: true, shell: 'x', retriable: true, on_fail: [{ do: 'retry', times: 2, delay: 0 }, { do: 'pause' }] }],
    plan: { 'a:s': fail } });
  engine.start(); await engine.idle();
  assert.equal(fake.calls.filter((k) => k === 'a:s').length, 3);
  assert.equal(run.cells.a.s.status, 'paused');
  assert.equal(run.cells.a.s.attempts, 3);
  assert.equal(run.cells.a.s.retriesUsed, 2);
});

test('retry succeeds on second attempt', async () => {
  const { engine, run } = mkEngine({ items: [{ name: 'a' }],
    steps: [{ name: 's', each: true, shell: 'x', retriable: true, on_fail: [{ do: 'retry', times: 2 }, { do: 'pause' }] }],
    plan: { 'a:s': [fail, okr] } });
  engine.start(); await engine.idle();
  assert.equal(run.cells.a.s.status, 'success');
  assert.equal(run.status, 'done');
});

test('agent rung runs a read-only diagnose once, then pauses; skip_item and abort rungs', async () => {
  const diag = [];
  const { engine, run } = mkEngine({ items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
    steps: [{ name: 's', each: true, shell: 'x', on_fail: [{ do: 'agent', prompt: 'why ${{ item.name }}?', then: 'pause' }] },
            { name: 't', each: true, shell: 'y', on_fail: [{ do: 'skip_item' }] },
            { name: 'u', each: true, shell: 'z', on_fail: [{ do: 'abort' }] }],
    plan: { 'a:s': fail, 'a:s#diagnose': (step, r) => { diag.push([step.agent.readonly, step.agent.prompt, r.logPath.endsWith('.diagnose.log')]); return { ok: true, output: {} }; },
            'b:t': fail, 'c:u': fail } });
  engine.start(); await engine.idle();
  assert.deepEqual(diag, [[true, 'why ${{ item.name }}?', true]]);
  assert.equal(run.cells.a.s.status, 'paused');
  assert.equal(run.cells.a.s.diagnosed, true);
  assert.equal(run.cells.b.t.status, 'skipped');
  assert.equal(run.items[1].status, 'skipped');
  assert.equal(run.status, 'aborted');
  assert.equal(run.cells.c.u.status, 'failed');
});

test('user actions: retry paused cell, skip cell, abort item, pause/resume run', async () => {
  const { engine, run } = mkEngine({
    steps: [{ name: 's', each: true, shell: 'x' }, { name: 't', each: true, shell: 'y' }],
    plan: { 'a:s': [fail, okr], 'b:s': fail } });
  engine.start(); await engine.idle();
  assert.equal(run.status, 'paused');
  engine.retry('a', 's'); await engine.idle();
  assert.equal(run.cells.a.t.status, 'success');
  engine.skipCell('b', 's'); await engine.idle();
  assert.equal(run.cells.b.s.status, 'skipped');
  assert.equal(run.cells.b.t.status, 'success');
  assert.equal(run.status, 'done');
  assert.throws(() => engine.retry('a', 't'), /run is done/);
});

test('retry/skipCell/answer refuse once the run reaches a terminal status', async () => {
  const { engine, run } = mkEngine({ items: [{ name: 'a' }],
    steps: [{ name: 's', each: true, shell: 'x' }], plan: { 'a:s': fail } });
  engine.start(); await engine.idle();
  assert.equal(run.cells.a.s.status, 'paused');
  await engine.abort('operator abort');
  assert.equal(run.status, 'aborted');
  assert.throws(() => engine.retry('a', 's'), /run is aborted/);
  assert.throws(() => engine.skipCell('a', 's'), /run is aborted/);
  assert.throws(() => engine.answer('a', 's', { answer: 'x' }), /run is aborted/);
});

test('pauseRun stops new cells, resumeRun continues; abortItem marks lane failed', async () => {
  const { engine, run } = mkEngine({ steps: [{ name: 's', each: true, shell: 'x' }, { name: 't', each: true, shell: 'y' }], plan: { 'b:s': fail } });
  engine.pauseRun(); engine.start(); await engine.idle();
  assert.equal(run.cells.a.s.status, 'pending');
  engine.resumeRun(); await engine.idle();
  assert.equal(run.cells.a.t.status, 'success');
  engine.abortItem('b'); await engine.idle();
  assert.equal(run.items[1].status, 'aborted');
  assert.equal(run.cells.b.s.status, 'failed');
  assert.equal(run.cells.b.t.status, 'failed');
  assert.equal(run.status, 'done');
});

test('max_attempts budget pauses automatic retries, but a user retry grants a fresh allowance', async () => {
  const { engine, run } = mkEngine({ items: [{ name: 'a' }],
    steps: [{ name: 's', each: true, shell: 'x', retriable: true, on_fail: [{ do: 'retry', times: 5, delay: 0 }, { do: 'pause' }] }],
    plan: { 'a:s': fail }, config: { limits: { max_attempts: 1 } } });
  engine.start(); await engine.idle();
  assert.equal(run.cells.a.s.attempts, 1);
  assert.match(run.cells.a.s.error, /budget: max_attempts/);
  // a user-triggered retry resets the counter, so the cell runs again instead of re-pausing on the budget
  engine.retry('a', 's'); await engine.idle();
  assert.equal(run.cells.a.s.attempts, 1);
  assert.match(run.cells.a.s.error, /budget: max_attempts/);
});

test('delayed retry: retryAt is persisted immediately, cell eventually succeeds', async () => {
  const { engine, run, home } = mkEngine({ items: [{ name: 'a' }],
    steps: [{ name: 's', each: true, shell: 'x', on_fail: [{ do: 'retry', times: 1, delay: 0.05 }, { do: 'pause' }] }],
    plan: { 'a:s': [fail, okr] } });
  engine.start();
  await new Promise((r) => setTimeout(r, 10));
  const mid = loadRun(home, run.id);
  assert.equal(typeof mid.cells.a.s.retryAt, 'number');
  await engine.idle();
  assert.equal(run.cells.a.s.status, 'success');
  const ev = run.history.find((e) => e.type === 'cell.retry_scheduled');
  assert.ok(ev);
  assert.equal(ev.delayMs, 50);
});

test('dirtyAfterKill blocks retry entirely', async () => {
  const { engine, run } = mkEngine({ items: [{ name: 'a' }], steps: [{ name: 's', each: true, shell: 'x' }],
    plan: { 'a:s': { ok: false, error: 'timeout', dirtyAfterKill: true } } });
  engine.start(); await engine.idle();
  assert.equal(run.cells.a.s.status, 'paused');
  assert.equal(run.cells.a.s.noRetry, true);
  assert.match(run.cells.a.s.error, /^dirty_after_kill:/);
  assert.throws(() => engine.retry('a', 's'), /retry blocked/);
});

test('abort: never-resolving cell is marked failed, pending timers are cleared', async () => {
  const { engine, run } = mkEngine({ items: [{ name: 'a' }, { name: 'b' }],
    steps: [{ name: 's', each: true, shell: 'x', on_fail: [{ do: 'retry', times: 1, delay: 0.5 }, { do: 'pause' }] }],
    plan: { 'a:s': () => new Promise(() => {}), 'b:s': fail } });
  engine.start();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(run.cells.a.s.status, 'running');
  assert.equal(engine.timers.size, 1);
  await engine.abort('test');
  assert.equal(run.status, 'aborted');
  assert.ok(run.finishedAt);
  assert.equal(run.cells.a.s.status, 'failed');
  assert.equal(engine.timers.size, 0);
});

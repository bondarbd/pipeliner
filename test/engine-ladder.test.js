import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkEngine } from './helpers.js';

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
  assert.throws(() => engine.retry('a', 't'), /cannot retry/);
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

test('max_attempts budget pauses the cell even when the user keeps retrying', async () => {
  const { engine, run } = mkEngine({ items: [{ name: 'a' }], steps: [{ name: 's', each: true, shell: 'x' }], plan: { 'a:s': fail }, config: { limits: { max_attempts: 2 } } });
  engine.start(); await engine.idle();
  engine.retry('a', 's'); await engine.idle();
  engine.retry('a', 's'); await engine.idle();
  assert.equal(run.cells.a.s.attempts, 2);
  assert.match(run.cells.a.s.error, /budget: max_attempts/);
});

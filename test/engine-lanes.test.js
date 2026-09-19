import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkEngine, statuses } from './helpers.js';

test('items flow through each-steps independently and outputs are exposed to later steps', async () => {
  const seen = [];
  const { engine, run, fake } = mkEngine({
    steps: [{ name: 's1', each: true, shell: 'x' }, { name: 's2', each: true, shell: 'echo ${{ item.steps.s1.v }}' }],
    plan: { 'a:s1': { ok: true, output: { v: 'A' } }, 'b:s1': { ok: true, output: { v: 'B' } },
      'a:s2': (step, r) => { seen.push(r.exprCtx.item.steps.s1.v); return { ok: true, output: {} }; },
      'b:s2': (step, r) => { seen.push(r.exprCtx.item.steps.s1.v); return { ok: true, output: {} }; } },
  });
  engine.start();
  await engine.idle();
  assert.deepEqual(statuses(run, 's2'), { a: 'success', b: 'success' });
  assert.deepEqual(seen.sort(), ['A', 'B']);
  assert.equal(run.status, 'done');
  assert.ok(run.finishedAt);
  assert.ok(fake.calls.indexOf('a:s2') > fake.calls.indexOf('a:s1'));
  assert.ok(run.history.some((e) => e.type === 'cell.started' && e.item === 'a' && e.step === 's1' && e.attempt === 1));
});

test('parallel limit is respected', async () => {
  let running = 0, peak = 0;
  const slow = async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 20)); running--; return { ok: true, output: {} }; };
  const { engine } = mkEngine({ steps: [{ name: 's', each: true, shell: 'x' }], items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }],
    plan: { 'a:s': slow, 'b:s': slow, 'c:s': slow, 'd:s': slow }, config: { limits: { parallel: 2 } } });
  engine.start(); await engine.idle();
  assert.equal(peak, 2);
});

test('when: false skips the cell; failure without on_fail pauses the lane, other lanes continue', async () => {
  const { engine, run } = mkEngine({
    steps: [{ name: 's1', each: true, shell: 'x', when: '${{ item.name !== "b" }}' }, { name: 's2', each: true, shell: 'y' }],
    plan: { 'a:s1': { ok: false, error: 'boom' } },
  });
  engine.start(); await engine.idle();
  assert.equal(run.cells.a.s1.status, 'paused');
  assert.equal(run.cells.a.s1.error, 'boom');
  assert.equal(run.cells.a.s2.status, 'pending');
  assert.equal(run.cells.b.s1.status, 'skipped');
  assert.equal(run.cells.b.s2.status, 'success');
  assert.equal(run.status, 'paused');
});

test('change events are emitted and run.json is persisted', async () => {
  const { engine, run, home } = mkEngine({ steps: [{ name: 's', each: true, shell: 'x' }] });
  let n = 0; engine.on('change', () => n++);
  engine.start(); await engine.idle();
  assert.ok(n >= 4);
  const { loadRun } = await import('../src/engine/store.js');
  assert.equal(loadRun(home, run.id).status, 'done');
});

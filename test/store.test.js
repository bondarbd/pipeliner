import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../src/engine/store.js';
import { buildCtx } from '../src/engine/context.js';

const tpl = { tpl: { name: 'demo', steps: [{ name: 'a', each: true, shell: 'x' }, { name: 'r', once: true, shell: 'y' }] }, hash: 'h'.repeat(64), dir: '/tpl' };
const mk = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-home-'));
  const run = store.createRun(home, { template: tpl, params: { n: '1' }, items: [{ name: 'p1', dir: '/p1' }, { name: 'p2' }], mode: 'pilot', initiator: { via: 'cli', user: 'me' } });
  return { home, run };
};

test('createRun initialises cells, dirs, pilot and run.md', () => {
  const { home, run } = mk();
  assert.match(run.id, /^\d{8}-\d{6}-[a-z0-9]{4}$/);
  assert.equal(run.cells.p1.a.status, 'pending');
  assert.equal(run.once.r.status, 'pending');
  assert.equal(run.items[0].status, 'active');
  assert.deepEqual(run.pilot, { item: 'p1', status: 'running' });
  assert.ok(fs.existsSync(path.join(run.dir, 'run.json')));
  assert.ok(fs.existsSync(store.paths(run, 'p1').logsDir));
  assert.match(fs.readFileSync(path.join(run.dir, 'context', 'run.md'), 'utf8'), /demo[\s\S]*"n": "1"/);
  assert.equal(store.loadRun(home, run.id).templateHash, 'h'.repeat(64));
  assert.equal(store.listRuns(home)[0].id, run.id);
});

test('outputs, notes, events, seq', () => {
  const { run } = mk();
  assert.equal(store.nextSeq(run), 1);
  assert.equal(store.nextSeq(run), 2);
  store.saveStepOutput(run, 'p1', 'a', { commit: 'abc' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store.paths(run, 'p1').stepsDir, 'a.json'), 'utf8')), { commit: 'abc' });
  store.appendNotes(run, 'p1', 'hello', 'agent');
  store.appendNotes(run, 'p1', 'x'.repeat(100), 'human');
  assert.match(store.readNotes(run, 'p1', 10_000), /\[agent\] hello[\s\S]*\[human\] x+/);
  assert.equal(store.readNotes(run, 'p1', 20).length, 20);
  assert.equal(store.readNotes(run, 'p2', 100), '');
  store.addEvent(run, { type: 't' });
  assert.equal(run.history.at(-1).type, 't');
  assert.ok(run.history.at(-1).t);
  assert.equal(store.itemCell(run, 'p9', 'a').status, 'pending');
});

test('item names that are prototype keys or paths are rejected; old run.json is migrated on load', () => {
  const { home, run } = mk();
  assert.throws(() => store.itemCell(run, '__proto__', 'a'), /invalid item name/);
  assert.throws(() => store.itemCell(run, 'x/y', 'a'), /invalid item name/);
  assert.throws(() => store.itemCell(run, '..', 'a'), /invalid item name/);
  assert.equal({}.a, undefined);
  // two different unsafe names never share a directory; safe names keep their own
  assert.notEqual(store.safe('альфа'), store.safe('омега'));
  assert.equal(store.safe('svc-a'), 'svc-a');
  assert.match(store.safe('app два'), /^app_.{3}-[0-9a-f]{8}$/);
  // strip fields a v1 file would not have
  const j = JSON.parse(fs.readFileSync(path.join(run.dir, 'run.json'), 'utf8'));
  delete j.budgets.since; delete j.items[0].addedAt; delete j.cells.p1.a.questions; delete j.cells.p1.a.via;
  fs.writeFileSync(path.join(run.dir, 'run.json'), JSON.stringify(j));
  const loaded = store.loadRun(home, run.id);
  assert.equal(loaded.budgets.since, loaded.createdAt);
  assert.equal(loaded.items[0].addedAt, loaded.createdAt);
  assert.equal(loaded.cells.p1.a.questions, 0);
  assert.equal(loaded.cells.p1.a.via, null);
  // a bare-bones run.json (older format) still loads and lists
  fs.writeFileSync(path.join(run.dir, 'run.json'), JSON.stringify({ id: run.id, dir: run.dir, templateName: 'demo', status: 'paused', createdAt: run.createdAt, updatedAt: run.createdAt, params: {}, steps: run.steps }));
  const bare = store.loadRun(home, run.id);
  assert.deepEqual([bare.items, bare.history, bare.seq, bare.budgets.agentCalls], [[], [], 0, 0]);
  assert.equal(store.listRuns(home)[0].id, run.id);
});

test('buildCtx exposes run/item/output namespaces', () => {
  const { run } = mk();
  run.cells.p1.a.output = { commit: 'abc' };
  run.once.r.output = { path: '/r.md' };
  const ctx = buildCtx({ run, item: run.items[0], config: { skills_root: '/skills' }, env: { A: '1' }, output: [1] });
  assert.equal(ctx.run.params.n, '1');
  assert.equal(ctx.run.skills, '/skills');
  assert.equal(ctx.run.steps.r.path, '/r.md');
  assert.equal(ctx.run.env.A, '1');
  assert.equal(ctx.item.steps.a.commit, 'abc');
  assert.equal(ctx.item.dir, '/p1');
  assert.equal(ctx.item.ctx, store.paths(run, 'p1').ctxDir);
  assert.deepEqual(ctx.output, [1]);
  assert.equal(buildCtx({ run, item: null, config: {} }).item, undefined);
});

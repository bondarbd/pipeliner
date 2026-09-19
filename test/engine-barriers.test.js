import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkEngine } from './helpers.js';
import { paths } from '../src/engine/store.js';

const fail = { ok: false, error: 'boom' };

test('barrier all waits for every active item; succeeded ignores paused lanes', async () => {
  const seen = [];
  const { engine, run } = mkEngine({ items: [{ name: 'a' }, { name: 'b' }],
    steps: [{ name: 's', each: true, shell: 'x' }, { name: 'r', once: true, barrier: 'succeeded', shell: 'y' }, { name: 't', each: true, shell: 'z' }],
    plan: { 'b:s': fail, '*:r': (step, r) => { seen.push(r.exprCtx.run.items.map((i) => run.cells[i.name].s.status)); return { ok: true, output: { path: '/r.md' } }; } } });
  engine.start(); await engine.idle();
  assert.deepEqual(seen, [['success', 'paused']]);
  assert.equal(run.once.r.status, 'success');
  assert.equal(run.cells.a.t.status, 'success');
  assert.equal(run.cells.b.t.status, 'pending');
  assert.equal(run.status, 'paused');

  const all = mkEngine({ items: [{ name: 'a' }, { name: 'b' }],
    steps: [{ name: 's', each: true, shell: 'x' }, { name: 'r', once: true, shell: 'y' }], plan: { 'b:s': fail } });
  all.engine.start(); await all.engine.idle();
  assert.equal(all.run.once.r.status, 'pending');
  all.engine.abortItem('b'); await all.engine.idle();
  assert.equal(all.run.once.r.status, 'success');
  assert.equal(all.run.status, 'done');
});

test('once step output is visible as run.steps.<name>; produced items join at the next step', async () => {
  const { engine, run } = mkEngine({ items: [],
    steps: [{ name: 'scan', once: true, shell: 'x', output: 'json', items: '${{ output.filter(p => p.vulnerable).map(p => ({ name: p.name, lib: p.lib })) }}' },
            { name: 'bump', each: true, shell: 'echo ${{ item.lib }} ${{ run.steps.scan.length }}' }],
    plan: { '*:scan': { ok: true, output: [{ name: 'p1', vulnerable: true, lib: 'log4j' }, { name: 'p2', vulnerable: false }, { name: 'p1', vulnerable: true, lib: 'dup' }] } } });
  engine.start(); await engine.idle();
  assert.deepEqual(run.items.map((i) => [i.name, i.lib, i.status]), [['p1', 'log4j', 'active']]);
  assert.equal(run.cells.p1.bump.status, 'success');
  assert.equal(run.status, 'done');
});

test('human step waits, answer continues or pauses, notes are written', async () => {
  const { engine, run } = mkEngine({ items: [{ name: 'a' }, { name: 'b' }],
    steps: [{ name: 'ask', each: true, human: { question: 'go ${{ item.name }}?', fields: ['why'] } }, { name: 't', each: true, shell: 'z' }] });
  engine.start(); await engine.idle();
  assert.equal(run.status, 'waiting_for_human');
  assert.deepEqual(run.cells.a.ask.waiting, { question: 'go a?', options: ['Да', 'Нет'], fields: ['why'] });
  engine.answer('a', 'ask', { answer: 'Да', fields: { why: 'ok' } });
  engine.answer('b', 'ask', { answer: 'Нет' });
  await engine.idle();
  assert.deepEqual(run.cells.a.ask.output, { answer: 'Да', why: 'ok' });
  assert.equal(run.cells.a.t.status, 'success');
  assert.equal(run.cells.b.ask.status, 'paused');
  assert.match(fs.readFileSync(paths(run, 'a').notes, 'utf8'), /Q: go a\?\nA: Да/);
  assert.throws(() => engine.answer('a', 'ask', { answer: 'x' }), /not waiting/);
});

test('needInput round trip: runner asks a follow-up question, answer resumes the same step', async () => {
  const { engine, run } = mkEngine({ items: [{ name: 'a' }],
    steps: [{ name: 's', each: true, shell: 'x' }],
    plan: { 'a:s': [{ ok: false, needInput: 'which version?' }, { ok: true, output: { v: '2' } }] } });
  engine.start(); await engine.idle();
  assert.equal(run.cells.a.s.status, 'waiting');
  assert.equal(run.cells.a.s.needInput, true);
  // fields: [] so the UI falls back to its free-text input (options is also empty)
  assert.deepEqual(run.cells.a.s.waiting.fields, []);
  engine.answer('a', 's', { answer: '2' });
  await engine.idle();
  assert.equal(run.cells.a.s.status, 'success');
  assert.equal(run.cells.a.s.attempts, 1);
  assert.match(fs.readFileSync(paths(run, 'a').notes, 'utf8'), /A: 2/);
});

test('an agent that keeps asking NEED_INPUT is paused after 3 rounds instead of looping', async () => {
  const { engine, run } = mkEngine({ items: [{ name: 'a' }],
    steps: [{ name: 's', each: true, shell: 'x' }],
    plan: { 'a:s': { ok: false, needInput: 'url?' } } });
  engine.start(); await engine.idle();
  for (let i = 0; i < 3; i++) {
    assert.equal(run.cells.a.s.status, 'waiting', `round ${i}`);
    engine.answer('a', 's', { answer: 'dunno' }); await engine.idle();
  }
  assert.equal(run.cells.a.s.status, 'paused');
  assert.match(run.cells.a.s.error, /asked for input 4 times, last: url\?/);
  engine.retry('a', 's'); await engine.idle();
  assert.equal(run.cells.a.s.status, 'waiting');   // user retry resets the question budget
});

test('pilot rejection pauses the run and re-asks after resume', async () => {
  const order = [];
  const rec = (step, r) => { order.push(`${r.item.name}:${step.name}:${r.pilotNotes ? 'notes' : '-'}`); return { ok: true, output: {} }; };
  const { engine, run } = mkEngine({ mode: 'pilot', items: [{ name: 'a' }, { name: 'b' }],
    steps: [{ name: 's', each: true, shell: 'x' }],
    plan: { 'a:s': rec, 'b:s': rec } });
  engine.start(); await engine.idle();
  assert.equal(run.pilot.status, 'waiting');
  engine.answer('__pilot__', null, { answer: 'Нет' });
  await engine.idle();
  assert.equal(run.pausedByUser, true);
  assert.match(run.note, /pilot rejected/);
  assert.equal(run.pilot.status, 'running');
  engine.resumeRun(); await engine.idle();
  assert.equal(run.pilot.status, 'waiting');
  assert.deepEqual(order, ['a:s:-']);
  fs.appendFileSync(paths(run, 'a').notes, 'pilot learned X');
  engine.answer('__pilot__', null, { answer: 'Да' }); await engine.idle();
  assert.deepEqual(order, ['a:s:-', 'b:s:notes']);
  assert.equal(run.status, 'done');
});

test('pilot mode: first item runs alone, then a pilot gate, then the rest with pilot notes', async () => {
  const order = [];
  const rec = (step, r) => { order.push(`${r.item.name}:${step.name}:${r.pilotNotes ? 'notes' : '-'}`); return { ok: true, output: {} }; };
  const { engine, run } = mkEngine({ mode: 'pilot', items: [{ name: 'a' }, { name: 'b' }],
    steps: [{ name: 's', each: true, shell: 'x' }, { name: 't', each: true, shell: 'y' }, { name: 'r', once: true, shell: 'z' }],
    plan: { 'a:s': rec, 'a:t': rec, 'b:s': rec, 'b:t': rec } });
  engine.start(); await engine.idle();
  assert.deepEqual(order, ['a:s:-', 'a:t:-']);
  assert.equal(run.pilot.status, 'waiting');
  assert.equal(run.status, 'waiting_for_human');
  fs.appendFileSync(paths(run, 'a').notes, 'pilot learned X');
  engine.answer('__pilot__', null, { answer: 'Да' }); await engine.idle();
  assert.deepEqual(order.slice(2), ['b:s:notes', 'b:t:notes']);
  assert.match(run.pilotNotes, /pilot learned X/);
  assert.equal(run.once.r.status, 'success');
  assert.equal(run.status, 'done');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as queue from '../src/queue.js';
import { boardRows } from '../src/board.js';

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rb-q-'));

test('add / list / open / done / drop', () => {
  const h = home();
  const a = queue.add(h, 'debts', { text: '  Петя: где дистрибутив?  ', link: 'sber://1' });
  const b = queue.add(h, 'debts', { text: 'обещал скинуть отчёт' });
  assert.equal(a.text, 'Петя: где дистрибутив?'); assert.equal(a.status, 'open'); assert.equal(b.link, null);
  assert.equal(fs.statSync(path.join(h, 'inbox', 'debts', `${a.id}.json`)).mode & 0o777, 0o600);
  assert.deepEqual(queue.queues(h), ['debts']);
  assert.deepEqual(queue.open(h, 'debts').map((i) => i.id), [a.id, b.id]);
  queue.done(h, 'debts', a.id); queue.drop(h, 'debts', b.id, 'nah');
  assert.deepEqual(queue.open(h, 'debts'), []);
  assert.deepEqual(queue.list(h).map((i) => [i.status, i.note]), [['done', null], ['dropped', 'nah']]);
  assert.throws(() => queue.add(h, 'debts', { text: '   ' }), /empty text/);
  assert.throws(() => queue.add(h, '../x', { text: 'y' }), /invalid queue name/);
  assert.throws(() => queue.done(h, 'debts', 'nope'), /no item/);
});

test('snooze: date forms, reopen when due, third snooze auto-closes', () => {
  const h = home();
  const wed = new Date(2026, 8, 23, 15); // Wednesday
  assert.equal(queue.snoozeDate('tomorrow', wed), '2026-09-24');
  assert.equal(queue.snoozeDate('завтра', wed), '2026-09-24');
  assert.equal(queue.snoozeDate('monday', wed), '2026-09-28');
  assert.equal(queue.snoozeDate('monday', new Date(2026, 8, 28, 9)), '2026-10-05');   // on a Monday: next one
  assert.equal(queue.snoozeDate('week', wed), '2026-09-30');
  assert.equal(queue.snoozeDate('2026-12-01', wed), '2026-12-01');
  assert.throws(() => queue.snoozeDate('fri'), /expected tomorrow\|monday\|week/);

  const it = queue.add(h, 'debts', { text: 'x' });
  let s = queue.snooze(h, 'debts', it.id, 'tomorrow');
  assert.equal(s.status, 'snoozed'); assert.equal(s.snoozes, 1); assert.ok(s.until > queue.localDate());
  assert.deepEqual(queue.open(h, 'debts'), []);
  assert.equal(queue.isOpen(s, s.until), true);           // due day: open again
  s = queue.snooze(h, 'debts', it.id, 'week');
  assert.equal(s.snoozes, 2);
  s = queue.snooze(h, 'debts', it.id, 'week');
  assert.equal(s.status, 'dropped'); assert.match(s.note, /auto-closed after 3 snoozes/);
});

test('board: waiting cells and overdue snoozes come first; --all adds running and open', () => {
  const run = { id: 'r1', templateName: 'release', createdAt: '2026-09-20T08:00:00Z', pilot: null,
    steps: [{ name: 'build', each: true }, { name: 'report', once: true }],
    items: [{ name: 'a', addedAt: '2026-09-20T08:00:00Z' }, { name: 'b', addedAt: '2026-09-20T08:00:00Z' }],
    cells: { a: { build: { status: 'paused', error: 'exit 2', startedAt: '2026-09-20T08:01:00Z' } }, b: { build: { status: 'running', startedAt: '2026-09-20T08:02:00Z' } } },
    once: { report: { status: 'pending' } } };
  const items = [
    { queue: 'debts', id: 'q1', status: 'snoozed', until: '2026-09-19', text: 'overdue one', createdAt: '2026-09-18T10:00:00Z', link: 'l1' },
    { queue: 'debts', id: 'q2', status: 'open', text: 'fresh', createdAt: '2026-09-20T09:00:00Z' },
    { queue: 'debts', id: 'q3', status: 'done', text: 'gone', createdAt: '2026-09-20T09:00:00Z' },
  ];
  const now = boardRows({ runs: [run], items, today: '2026-09-20' });
  assert.deepEqual(now.map((r) => [r.group, r.item, r.state, r.needsMe]), [['debts', 'q1', 'overdue', true], ['release', 'a', 'paused', true]]);
  assert.equal(now[0].link, 'l1');
  const all = boardRows({ runs: [run], items, all: true, today: '2026-09-20' });
  assert.deepEqual(all.map((r) => [r.item, r.state]), [['q1', 'overdue'], ['a', 'paused'], ['q2', 'open'], ['b', 'running']]);
});

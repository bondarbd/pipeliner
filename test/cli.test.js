import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const bin = path.resolve('bin/runboard.js');
function sh(args, env = {}) {
  try { return { code: 0, out: execFileSync('node', [bin, ...args], { encoding: 'utf8', env: { ...process.env, ...env } }) }; }
  catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; }
}

test('init, doctor, validate, render, dry-run and a real hello run', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-cli-'));
  const env = { RUNBOARD_HOME: home };
  let r = sh(['init'], env);
  assert.equal(r.code, 0); assert.ok(fs.existsSync(path.join(home, 'config.yaml')));
  // Never let doctor read the real ~/.config/release/env or call out to Jenkins: point
  // env_file at /dev/null and projects_root at a scratch dir before running doctor.
  fs.writeFileSync(path.join(home, 'config.yaml'), `env_file: /dev/null\nprojects_root: ${home}\n`);
  r = sh(['doctor'], env);
  assert.match(r.out, /node .*✓/); assert.match(r.out, /gigacode|agent command/);
  r = sh(['validate', 'templates/hello.yaml'], env);
  assert.equal(r.code, 0); assert.match(r.out, /OK hello/);
  fs.writeFileSync(path.join(home, 'bad.yaml'), 'name: bad\nsteps:\n  - { name: s, each: true }\n');
  r = sh(['validate', path.join(home, 'bad.yaml')], env);
  assert.equal(r.code, 1); assert.match(r.out, /steps\[0\]: exactly one body/);
  r = sh(['render', 'hello', '--step', 'greet', '--item', 'alpha', '--param', 'greeting=Yo'], env);
  assert.match(r.out, /echo "message=Yo, alpha"/);
  r = sh(['run', 'hello', '--dry-run'], env);
  assert.equal(r.code, 0); assert.match(r.out, /alpha +greet +echo "message=Привет, alpha"/); assert.match(r.out, /\* +summary +js:/);
  r = sh(['run', 'hello'], env);
  assert.equal(r.code, 3); assert.match(r.out, /not trusted/);
  r = sh(['run', 'hello', '--yes', '--answer', 'Да'], env);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /gamma +flaky +paused/);
  assert.match(r.out, /summary +success/);
  r = sh(['list'], env);
  assert.match(r.out, /hello +paused/);
  const id = r.out.match(/(\d{8}-\d{6}-\w{4})/)[1];
  r = sh(['retry', id, 'gamma', 'flaky'], env);
  assert.equal(r.code, 2);
  r = sh(['show', id], env);
  assert.equal(r.code, 0);                                   // show reports state, it is not a failure
  assert.match(r.out, /gamma +flaky +paused +exit 2: permanent error/);
  r = sh(['log', id, 'gamma', 'flaky'], env);
  assert.equal(r.code, 0); assert.match(r.out, /flaky\.\d+\.log[\s\S]*permanent error: pom.xml broken/);
  r = sh(['skip', id, 'gamma', 'flaky'], env);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /status=done/);
  r = sh(['retry', id, 'gamma', 'flaky'], env);
  assert.equal(r.code, 1); assert.match(r.out, /is done — nothing to do/);
  r = sh(['render', 'hello', '--step', 'greet'], env);       // no --item: first item is used
  assert.equal(r.code, 0); assert.match(r.out, /alpha/);
});

test('debts: add → board → morning run → answers close, snooze or keep items', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-cli-q-'));
  const env = { RUNBOARD_HOME: home };
  fs.writeFileSync(path.join(home, 'config.yaml'), 'env_file: /dev/null\n');
  let r = sh(['add', 'debts', 'Петя:', 'где', 'дистрибутив?', '--link', 'sber://t/1'], env);
  assert.equal(r.code, 0); const id1 = r.out.match(/added debts\/(\S+)/)[1];
  r = sh(['add', 'debts', 'обещал отчёт'], env); const id2 = r.out.match(/added debts\/(\S+)/)[1];
  r = sh(['queue'], env);
  assert.match(r.out, new RegExp(`debts +${id1} +open .*Петя: где дистрибутив\\? +sber://t/1`));
  r = sh(['board'], env);
  assert.match(r.out, /nothing needs you now/);
  r = sh(['board', '--all'], env);
  assert.match(r.out, new RegExp(`debts +${id1} +open`));

  // morning run without a terminal: stops at the human step, exit 2
  r = sh(['run', 'debts', '--yes'], env);
  assert.equal(r.code, 2, r.out); assert.match(r.out, /waiting for input/);
  const runId = r.out.match(/(\d{8}-\d{6}-\w{4})/)[1];
  r = sh(['board'], env);
  assert.match(r.out, new RegExp(`debts +${id1} +reply +waiting .*Петя: где дистрибутив\\? +sber://t/1 +${runId}`));

  r = sh(['answer', runId, id1, 'reply', 'Отправил'], env);
  assert.equal(r.code, 2);                                  // id2 still waiting
  r = sh(['answer', runId, id2, 'reply', 'Завтра'], env);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /status=done/);
  r = sh(['queue'], env);
  assert.doesNotMatch(r.out, new RegExp(id1)); assert.match(r.out, new RegExp(`${id2} +snoozed до \\d{4}-\\d{2}-\\d{2}`));

  // a run with nothing open is a no-op
  r = sh(['run', 'debts', '--yes'], env);
  assert.equal(r.code, 0); assert.match(r.out, /no open items in queue debts/);
  r = sh(['snooze', 'debts', id2, 'week'], env); r = sh(['snooze', 'debts', id2, 'week'], env);
  assert.match(r.out, /dropped .*auto-closed after 3 snoozes/);
});

test('run without a terminal leaves a NEED_INPUT question unanswered instead of feeding it --answer', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-cli-ni-'));
  const env = { RUNBOARD_HOME: home };
  fs.mkdirSync(path.join(home, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config.yaml'), 'env_file: /dev/null\n');
  // a shell step behaves like an agent that needs input: the engine turns NEED_INPUT into a waiting cell
  fs.writeFileSync(path.join(home, 'templates', 'ask.yaml'), 'name: ask\nitems: { source: manual, default: [{ name: p }] }\nsteps:\n  - { name: s, each: true, shell: "echo NEED_INPUT=which version?; exit 1" }\n');
  const r = sh(['run', 'ask', '--yes', '--answer', 'Да'], env);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /paused|waiting/);
});

test('run --dry-run never attaches an engine: a run.json with a running cell is left byte-identical', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-cli-dry-'));
  const env = { RUNBOARD_HOME: home };
  sh(['init'], env);
  let r = sh(['run', 'hello', '--yes', '--answer', 'Да'], env);
  assert.equal(r.code, 2, r.out);
  const id = r.out.match(/(\d{8}-\d{6}-\w{4})/)[1];
  const file = path.join(home, 'runs', id, 'run.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  j.status = 'running';
  j.cells.alpha.greet.status = 'running';
  fs.writeFileSync(file, JSON.stringify(j, null, 1));
  const before = fs.readFileSync(file, 'utf8');

  r = sh(['run', 'hello', '--dry-run'], env);
  assert.equal(r.code, 0, r.out);

  const after = fs.readFileSync(file, 'utf8');
  assert.equal(after, before);
});

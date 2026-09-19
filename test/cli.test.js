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
  assert.match(r.out, /gamma +flaky +paused/);
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

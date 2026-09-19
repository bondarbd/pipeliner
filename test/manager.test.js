import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Manager, NeedsTrust } from '../src/engine/manager.js';
import { loadConfig } from '../src/config.js';
import { fakeRunner } from '../src/runners/fake.js';
import * as human from '../src/runners/human.js';

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-mgr-'));
  const tdir = path.join(home, 'templates'); fs.mkdirSync(tdir);
  const proj = path.join(home, 'projects'); fs.mkdirSync(path.join(proj, 'p1'), { recursive: true }); fs.mkdirSync(path.join(proj, 'p2'));
  fs.writeFileSync(path.join(tdir, 'demo.yaml'), `name: demo\nparams:\n  n: { type: string, required: true }\nitems: { source: dirs }\nsteps:\n  - { name: s, each: true, shell: "echo ${'$'}{{ run.params.n }}" }\n`);
  const cfg = loadConfig(home); cfg.projects_root = proj;
  const fake = fakeRunner({});
  const m = new Manager({ home, config: cfg, runners: { shell: fake, js: fake, agent: fake, human }, envValues: {}, templateDirs: [tdir] });
  return { home, m, fake, proj };
}

test('templates load, params are checked, trust is required once, run executes', async () => {
  const { m, fake, proj } = setup();
  await m.init();
  assert.ok(m.templates.has('demo'));
  assert.deepEqual(m.checkParams(m.templates.get('demo').tpl, {}), [{ path: 'params.n', message: 'required' }]);
  await assert.rejects(m.create({ templateName: 'demo', params: { n: '1' }, items: ['p1'] }), (e) => e instanceof NeedsTrust && e.commands[0].includes('echo'));
  m.trust('demo', m.templates.get('demo').hash);
  const run = await m.create({ templateName: 'demo', params: { n: '1' }, items: ['p1', 'p2'], initiator: { via: 'test' } });
  assert.deepEqual(run.items.map((i) => i.dir), [path.join(proj, 'p1'), path.join(proj, 'p2')]);
  await m.engine(run.id).idle();
  assert.equal(m.get(run.id).status, 'done');
  assert.equal(fake.calls.length, 2);
  await assert.rejects(m.create({ templateName: 'demo', params: { n: '1' }, items: ['nope'] }), /not found/);
});

test('params.<k>.pattern: a value that fails it is rejected before trust/run, matching message', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-mgr-pat-'));
  const tdir = path.join(home, 'templates'); fs.mkdirSync(tdir);
  const proj = path.join(home, 'projects'); fs.mkdirSync(path.join(proj, 'p1'), { recursive: true });
  fs.writeFileSync(path.join(tdir, 'demo.yaml'), 'name: demo\nparams:\n  release: { type: string, required: true, pattern: "^[0-9]+$" }\nitems: { source: dirs }\nsteps:\n  - { name: s, each: true, shell: "echo hi" }\n');
  const cfg = loadConfig(home); cfg.projects_root = proj;
  const fake = fakeRunner({});
  const m = new Manager({ home, config: cfg, runners: { shell: fake, js: fake, agent: fake, human }, envValues: {}, templateDirs: [tdir] });
  await m.init();
  assert.deepEqual(m.checkParams(m.templates.get('demo').tpl, { release: 'abc' }), [{ path: 'params.release', message: 'must match ^[0-9]+$' }]);
  await assert.rejects(m.create({ templateName: 'demo', params: { release: 'abc' }, items: ['p1'] }), /must match/);
  m.trust('demo', m.templates.get('demo').hash);
  const run = await m.create({ templateName: 'demo', params: { release: '247' }, items: ['p1'] });
  await m.engine(run.id).idle();
  assert.equal(m.get(run.id).status, 'done');
});

test('init recovers unfinished runs from disk', async () => {
  const { m, home } = setup();
  await m.init();
  m.trust('demo', m.templates.get('demo').hash);
  const run = await m.create({ templateName: 'demo', params: { n: '1' }, items: ['p1'] });
  await m.engine(run.id).idle();
  const file = path.join(run.dir, 'run.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  j.status = 'running'; j.cells.p1.s.status = 'running'; j.cells.p1.s.pid = null;
  fs.writeFileSync(file, JSON.stringify(j));
  const m2 = new Manager({ home, config: m.config, runners: m.runners, envValues: {}, templateDirs: m.templateDirs });
  await m2.init();
  await m2.engine(run.id).idle();
  assert.equal(m2.get(run.id).cells.p1.s.status, 'interrupted');
  assert.equal(m2.list()[0].id, run.id);
});

test('init({recover:false}) loads templates but never attaches or recovers unfinished runs', async () => {
  const { m, home } = setup();
  await m.init();
  m.trust('demo', m.templates.get('demo').hash);
  const run = await m.create({ templateName: 'demo', params: { n: '1' }, items: ['p1'] });
  await m.engine(run.id).idle();
  const file = path.join(run.dir, 'run.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  j.status = 'running'; j.cells.p1.s.status = 'running'; j.cells.p1.s.pid = null;
  fs.writeFileSync(file, JSON.stringify(j));

  const m2 = new Manager({ home, config: m.config, runners: m.runners, envValues: {}, templateDirs: m.templateDirs });
  await m2.init({ recover: false });
  assert.ok(m2.templates.has('demo'));
  assert.equal(m2.engines.size, 0);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).cells.p1.s.status, 'running');
});

test('templateCommands lists a js step\'s sidecar script', async () => {
  const { m } = setup();
  fs.writeFileSync(path.join(m.templateDirs[0], 'demo2.yaml'), 'name: demo2\nsteps:\n  - { name: r, once: true, js: ./demo2/report.js }\n');
  fs.mkdirSync(path.join(m.templateDirs[0], 'demo2'));
  fs.writeFileSync(path.join(m.templateDirs[0], 'demo2', 'report.js'), 'export default async () => ({});\n');
  await m.init();
  const t2 = m.templates.get('demo2');
  assert.ok(t2);
  const commands = m.templateCommands(t2);
  assert.ok(commands.some((c) => c.includes('demo2/report.js')));
  assert.ok(commands.some((c) => c === `sidecar: ${path.join('demo2', 'report.js')}`));
});

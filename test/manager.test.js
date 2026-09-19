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

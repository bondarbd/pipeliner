import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Manager } from '../src/engine/manager.js';
import { loadConfig } from '../src/config.js';
import { previewRows } from '../src/preview.js';

async function setup(yaml) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-prev-'));
  const tdir = path.join(home, 'templates'); fs.mkdirSync(tdir);
  const proj = path.join(home, 'projects'); fs.mkdirSync(path.join(proj, 'p1', '.git'), { recursive: true });
  fs.writeFileSync(path.join(tdir, 't.yaml'), yaml);
  const cfg = loadConfig(home); cfg.projects_root = proj;
  const m = await new Manager({ home, config: cfg, runners: {}, envValues: {}, templateDirs: [tdir] }).init({ recover: false });
  return { m, t: m.templates.get('t') };
}

test('preview renders unknown step outputs as placeholders and applies param defaults', async () => {
  const { m, t } = await setup(`name: t
params:
  ver: { type: string, default: "1.12.0" }
items: { source: dirs }
steps:
  - { name: a, each: true, shell: "echo commit=1" }
  - { name: b, each: true, shell: "build --commit \${{ item.steps.a.commit }} --ver \${{ run.params.ver }}" }
  - { name: r, once: true, shell: "echo path=x" }
  - { name: pub, once: true, agent: { prompt: "publish \${{ run.steps.r.path }}" }, verify: "true" }
`);
  const rows = previewRows(m, t, { items: ['p1'] });
  assert.deepEqual(rows.map((r) => r.command), ['echo commit=1', 'build --commit @a.commit --ver 1.12.0', 'echo path=x', 'agent: publish @r.path']);
  assert.equal(previewRows(m, t, { params: { ver: '2' }, items: ['p1'] })[1].command, 'build --commit @a.commit --ver 2');
});

test('preview validates params like a real run (pattern, required)', async () => {
  const { m, t } = await setup('name: t\nparams:\n  release: { type: string, required: true, pattern: "^[0-9]+$" }\nitems: { source: dirs }\nsteps:\n  - { name: a, each: true, shell: "echo release/0.${{ run.params.release }}" }\n');
  assert.throws(() => previewRows(m, t, { params: { release: '0.301' }, items: ['p1'] }), /params.release must match \^\[0-9\]\+\$/);
  assert.throws(() => previewRows(m, t, { items: ['p1'] }), /params.release required/);
  assert.equal(previewRows(m, t, { params: { release: '301' }, items: ['p1'] })[0].command, 'echo release/0.301');
});

test('a dirs template without items is a clear error, not an empty table', async () => {
  const { m, t } = await setup('name: t\nitems: { source: dirs }\nsteps:\n  - { name: a, each: true, shell: "echo 1" }\n');
  assert.throws(() => previewRows(m, t, {}), /pass --items a,b \(available: p1\)/);
  await assert.rejects(m.create({ templateName: 't' }), /pass --items/);
});

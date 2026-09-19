import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateTemplate } from '../src/template/validate.js';
import { loadTemplates, readTemplate } from '../src/template/load.js';

const ok = () => ({
  name: 'demo', params: { release: { type: 'string', required: true } }, items: { source: 'dirs' },
  steps: [
    { name: 'branch', each: true, shell: 'echo commit=1', output: 'keys' },
    { name: 'build', each: true, shell: 'echo ${{ item.steps.branch.commit }}', retriable: true,
      on_fail: [{ do: 'retry', times: 2, delay: 0 }, { do: 'agent', prompt: 'why?', then: 'pause' }, { do: 'pause' }] },
    { name: 'report', once: true, barrier: 'succeeded', js: './steps/r.js', output: 'json' },
    { name: 'publish', once: true, agent: { prompt: 'do ${{ run.steps.report.path }}' }, verify: 'true' },
    { name: 'ask', each: true, human: { question: 'ok?' } },
  ],
});
const msgs = (t) => validateTemplate(t).map((e) => `${e.path}: ${e.message}`);

test('params.<k>.pattern: valid regex is accepted, invalid one is rejected', () => {
  const good = ok(); good.params.release.pattern = '^[0-9]+$';
  assert.deepEqual(msgs(good), []);
  const bad = ok(); bad.params.release.pattern = '[unclosed';
  const m = msgs(bad);
  assert.ok(m.some((x) => x.includes('params.release.pattern')));
});

test('valid template has no errors', () => { assert.deepEqual(msgs(ok()), []); });

test('structural errors', () => {
  const t = ok();
  t.steps[0].once = true;                              // each + once
  t.steps[1].retriable = false;                        // retry without retriable
  delete t.steps[3].verify;                            // agent without verify
  t.steps[2].shell = 'x';                              // two bodies
  t.steps[4].name = 'branch';                          // duplicate
  const m = msgs(t);
  assert.ok(m.some((x) => x.includes('steps[0]: exactly one of each')));
  assert.ok(m.some((x) => x.includes('steps[1].on_fail[0]: retry requires retriable')));
  assert.ok(m.some((x) => x.includes('steps[3].verify: agent step requires verify')));
  assert.ok(m.some((x) => x.includes('steps[2]: exactly one body')));
  assert.ok(m.some((x) => x.includes('duplicate step name branch')));
});

test('ladder must end with a terminal rung; unknown step refs are reported', () => {
  const t = ok();
  t.steps[1].on_fail = [{ do: 'retry', times: 1 }];
  t.steps[1].shell = 'echo ${{ item.steps.brnch.commit }}';
  const m = msgs(t);
  assert.ok(m.some((x) => x.includes('last rung must be pause|skip_item|abort')));
  assert.ok(m.some((x) => x.includes("unknown or later step 'brnch'")));
});

test('loadTemplates reads yaml dirs, later dir overrides, invalid files are reported', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-ta-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-tb-'));
  fs.writeFileSync(path.join(a, 'demo.yaml'), 'name: demo\nsteps:\n  - { name: s, each: true, shell: echo a }\n');
  fs.writeFileSync(path.join(b, 'demo.yaml'), 'name: demo\nsteps:\n  - { name: s, each: true, shell: echo b }\n');
  fs.writeFileSync(path.join(b, 'bad.yaml'), 'name: bad\nsteps: []\n');
  const { templates, errors } = loadTemplates([a, b]);
  assert.equal(templates.get('demo').tpl.steps[0].shell, 'echo b');
  assert.equal(templates.get('demo').dir, b);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, path.join(b, 'bad.yaml'));
  const r = readTemplate(path.join(a, 'demo.yaml'));
  assert.match(r.hash, /^[0-9a-f]{64}$/);
});

test('sidecar files (step.js and files under <dir>/<name>/) are folded into the template hash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-side-'));
  const file = path.join(dir, 'demo.yaml');
  fs.writeFileSync(file, 'name: demo\nsteps:\n  - { name: r, once: true, js: ./demo/report.js }\n');
  fs.mkdirSync(path.join(dir, 'demo'));
  fs.writeFileSync(path.join(dir, 'demo', 'report.js'), 'export default async () => ({ a: 1 });\n');

  const before = readTemplate(file);
  assert.deepEqual(before.sidecars, [path.join('demo', 'report.js')]);

  // editing the sidecar script changes the hash even though the yaml text is unchanged
  fs.writeFileSync(path.join(dir, 'demo', 'report.js'), 'export default async () => ({ a: 2 });\n');
  const after = readTemplate(file);
  assert.notEqual(before.hash, after.hash);

  // a missing js file is ignored for hashing (validated elsewhere), not fatal
  fs.rmSync(path.join(dir, 'demo', 'report.js'));
  assert.doesNotThrow(() => readTemplate(file));
});

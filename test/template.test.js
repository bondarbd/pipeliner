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

test('ladder must end with a terminal rung; unknown step refs are reported with a suggestion', () => {
  const t = ok();
  t.steps[1].on_fail = [{ do: 'retry', times: 1 }];
  t.steps[1].shell = 'echo ${{ item.steps.brnch.commit }}';
  const m = msgs(t);
  assert.ok(m.some((x) => x.includes('last rung must be pause|skip_item|abort')));
  assert.ok(m.some((x) => x.includes("unknown or later step 'brnch' (did you mean 'branch'?)")));
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

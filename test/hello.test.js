import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Manager } from '../src/engine/manager.js';
import { loadConfig } from '../src/config.js';
import { defaultRunners } from '../src/runners/index.js';

test('hello template runs end to end with real runners', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-hello-'));
  const cfg = loadConfig(home);
  const m = new Manager({ home, config: cfg, runners: await defaultRunners(), envValues: {}, templateDirs: [path.resolve('templates')] });
  await m.init();
  const t = m.templates.get('hello');
  assert.ok(t, `template errors: ${JSON.stringify(m.templateErrors)}`);
  m.trust('hello', t.hash);
  const run = await m.create({ templateName: 'hello', params: { greeting: 'Hi' }, items: [] });
  const e = m.engine(run.id);
  await e.idle();
  assert.equal(run.cells.alpha.greet.output.message, 'Hi, alpha');
  assert.equal(run.cells.beta.flaky.status, 'success');
  assert.equal(run.cells.beta.flaky.attempts, 2);
  assert.equal(run.cells.gamma.flaky.status, 'paused');
  assert.equal(run.once.confirm.status, 'waiting');
  assert.equal(run.status, 'waiting_for_human');
  e.answer(null, 'confirm', { answer: 'Да' });
  await e.idle();
  assert.equal(run.once.summary.status, 'success');
  assert.match(fs.readFileSync(run.once.summary.output.path, 'utf8'), /\| beta \| active \| ok-after-retry \|/);
  assert.equal(run.status, 'paused');   // gamma still paused
  e.skipCell('gamma', 'flaky'); await e.idle();
  assert.equal(run.status, 'done');
});

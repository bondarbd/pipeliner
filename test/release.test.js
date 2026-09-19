import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { Manager } from '../src/engine/manager.js';
import { defaultRunners } from '../src/runners/index.js';

test('release template: check short-circuits, retry on build, report and verified publish via fake agent', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-rel-'));
  const proj = path.join(home, 'projects');
  for (const n of ['app1', 'flaky', 'app два']) fs.mkdirSync(path.join(proj, n, '.git'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'app1', '.branches'), 'release/0.247\n'); fs.writeFileSync(path.join(proj, 'app1', '.sha'), 'pre-existing-sha\n');
  const cfg = loadConfig(home);
  cfg.projects_root = proj; cfg.skills_root = path.resolve('test/fixtures/skills');
  cfg.agent.command = [path.resolve('test/fixtures/fake-agent.sh'), '-p', '{prompt}'];
  const env = { JENKINS_TOKEN: 'tok', FAKE_AGENT_MODE: 'keys', MOCK_CONFLUENCE_OK: '1' };
  const m = new Manager({ home, config: cfg, runners: await defaultRunners(), envValues: env, templateDirs: [path.resolve('templates')] });
  await m.init();
  const t = m.templates.get('release'); assert.ok(t, JSON.stringify(m.templateErrors));
  // the fake agent and mocks need these env names whitelisted; extend the steps for the test only
  for (const s of t.tpl.steps) s.env = [...(s.env || []), 'FAKE_AGENT_MODE', 'MOCK_CONFLUENCE_OK', 'JENKINS_TOKEN'];
  t.tpl.steps.find((s) => s.name === 'build').on_fail[0].delay = 0;
  m.trust('release', t.hash);
  const run = await m.create({ templateName: 'release', params: { release: '247' }, items: ['app1', 'flaky', 'app два'] });
  const e = m.engine(run.id); await e.idle();
  assert.equal(run.cells.app1.branch.output.commit, 'pre-existing-sha');
  assert.ok(run.history.some((h) => h.type === 'cell.success' && h.item === 'app1' && h.step === 'branch' && h.how === 'check'));
  assert.match(run.cells.flaky.branch.output.commit, /^[0-9a-f]{40}$/);
  assert.equal(run.cells.flaky.build.attempts, 2);
  assert.equal(run.cells.flaky.build.output.result, 'SUCCESS');
  assert.equal(run.once.report.status, 'success');
  const md = fs.readFileSync(run.once.report.output.path, 'utf8');
  assert.match(md, /\| app1 \| `release\/0.247` \| \[#42\]/);
  // item name with a space/Cyrillic: safe() must be used for the on-disk items/<name> path
  // (src/engine/store.js), or its step outputs never get read and the report row shows '-'.
  const two = run.once.report.output.rows.find((r) => r.project === 'app два');
  assert.ok(two, JSON.stringify(run.once.report.output.rows));
  assert.notEqual(two.commit, '-');
  assert.match(md, /\| app два \| `release\/0.247` \|.*\| `[0-9a-f]{40}` \|/);
  assert.equal(run.once.publish.status, 'success', run.once.publish.error);
  assert.equal(run.status, 'done');
  assert.ok(execFileSync('ls', [path.join(run.dir, 'out')]).toString().includes('publish.'));
});

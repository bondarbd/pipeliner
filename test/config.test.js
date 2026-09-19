import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, loadEnvFile, expandHome } from '../src/config.js';

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rb-')); }

test('defaults when config.yaml is missing', () => {
  const home = tmpHome();
  const cfg = loadConfig(home);
  assert.equal(cfg.home, home);
  assert.equal(cfg.limits.parallel, 4);
  assert.deepEqual(cfg.agent.command, ['gigacode', '-p', '{prompt}', '--approval-mode', 'auto-edit']);
  assert.ok(!cfg.projects_root.startsWith('~'));
});

test('user config deep-merges and expands ~', () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, 'config.yaml'), 'projects_root: ~/work\nlimits:\n  parallel: 2\nagent:\n  command: [claude, -p, "{prompt}"]\n');
  const cfg = loadConfig(home);
  assert.equal(cfg.projects_root, path.join(os.homedir(), 'work'));
  assert.equal(cfg.limits.parallel, 2);
  assert.equal(cfg.limits.max_attempts, 3);
  assert.deepEqual(cfg.agent.command, ['claude', '-p', '{prompt}']);
  assert.equal(cfg.agent.max_parallel, 2);
});

test('env file parser handles comments, quotes, missing file', () => {
  const home = tmpHome();
  const f = path.join(home, 'env');
  fs.writeFileSync(f, '# c\nJENKINS_URL=https://j\nJENKINS_TOKEN="abc" # tok\nEMPTY=\nbad line\n');
  assert.deepEqual(loadEnvFile(f), { JENKINS_URL: 'https://j', JENKINS_TOKEN: 'abc', EMPTY: '' });
  assert.deepEqual(loadEnvFile(path.join(home, 'nope')), {});
  assert.equal(expandHome('~/x'), path.join(os.homedir(), 'x'));
});

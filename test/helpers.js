import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import * as store from '../src/engine/store.js';
import { Engine } from '../src/engine/run.js';
import { fakeRunner } from '../src/runners/fake.js';
import * as human from '../src/runners/human.js';

export function mkEngine({ steps, items = [{ name: 'a' }, { name: 'b' }], plan = {}, mode = 'all', config = {}, envValues = {}, params = {} }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-eng-'));
  const cfg = loadConfig(home);
  Object.assign(cfg.limits, config.limits || {});
  Object.assign(cfg.agent, config.agent || {});
  cfg.skills_root = '/skills';
  const template = { tpl: { name: 'demo', steps }, hash: 'h'.repeat(64), dir: home };
  const run = store.createRun(home, { template, params, items, mode, initiator: { via: 'test' } });
  const fake = fakeRunner(plan);
  const runners = { shell: fake, js: fake, agent: fake, human };
  const engine = new Engine({ run, config: cfg, runners, envValues, sleep: () => Promise.resolve() });
  return { engine, run, home, fake, runners, cfg };
}

export const statuses = (run, step) => Object.fromEntries(run.items.map((i) => [i.name, run.cells[i.name]?.[step]?.status]));

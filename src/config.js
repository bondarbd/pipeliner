import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

export const DEFAULTS = {
  projects_root: '~/projects',
  skills_root: '~/.gigacode/skills',
  env_file: '~/.config/release/env',
  agent: {
    command: ['gigacode', '-p', '{prompt}', '--approval-mode', 'auto-edit'],
    readonly_command: ['gigacode', '-p', '{prompt}', '--approval-mode', 'plan'],
    max_parallel: 2,
    timeout: 1800,
  },
  limits: { parallel: 4, max_attempts: 3, max_agent_calls: 30, run_timeout: 21600, lock_wait: 600, max_new_items: 50 },
  logs: { retention_days: 14, max_step_log_bytes: 5_000_000 },
  git: { allowed_push_branches: ['release/*', 'feature/*'] },
  server: { port: 3000 },
};

export function expandHome(p) {
  return typeof p === 'string' && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

export function defaultHome() {
  return process.env.RUNBOARD_HOME || path.join(os.homedir(), '.runboard');
}

function deepMerge(target, src) {
  for (const [k, v] of Object.entries(src || {})) {
    const isObj = v && typeof v === 'object' && !Array.isArray(v);
    if (isObj && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) deepMerge(target[k], v);
    else target[k] = v;
  }
  return target;
}

export function loadConfig(home) {
  const file = path.join(home, 'config.yaml');
  const user = fs.existsSync(file) ? (YAML.parse(fs.readFileSync(file, 'utf8')) || {}) : {};
  const cfg = deepMerge(structuredClone(DEFAULTS), user);
  for (const k of ['projects_root', 'skills_root', 'env_file']) cfg[k] = expandHome(cfg[k]);
  cfg.home = home;
  return cfg;
}

export function loadEnvFile(file) {
  if (!file || !fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).split(' #')[0].trim();
    v = v.replace(/^["']|["']$/g, '');
    out[k] = v;
  }
  return out;
}

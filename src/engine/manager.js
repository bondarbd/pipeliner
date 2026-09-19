import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as store from './store.js';
import { Engine } from './run.js';
import { loadTemplates } from '../template/load.js';
import { bodyKind } from '../template/validate.js';
import * as queue from '../queue.js';

export class NeedsTrust extends Error {
  constructor(name, hash, commands) { super(`template ${name} (${hash.slice(0, 12)}) is not trusted yet`); this.name = 'NeedsTrust'; this.templateName = name; this.hash = hash; this.commands = commands; }
}

export class Manager {
  constructor({ home, config, runners, envValues = {}, templateDirs }) {
    this.home = home; this.config = config; this.runners = runners; this.envValues = envValues;
    this.templateDirs = templateDirs;
    this.engines = new Map();
    this.templates = new Map(); this.templateErrors = [];
  }

  // recover: true = attach and resume every unfinished run (the server), a run id = only that
  // one (a CLI command about it), false = none (render, dry-run, creating a new run)
  async init({ recover = true } = {}) {
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    this.reloadTemplates();
    for (const s of recover ? store.listRuns(this.home) : []) {
      if (['done', 'aborted'].includes(s.status) || (recover !== true && s.id !== recover)) continue;
      await this.attach(store.loadRun(this.home, s.id)).recover();
    }
    return this;
  }
  reloadTemplates() {
    const { templates, errors } = loadTemplates(this.templateDirs);
    this.templates = templates; this.templateErrors = errors;
  }
  attach(run) {
    const engine = new Engine({ run, config: this.config, runners: this.runners, envValues: this.envValues, projectDir: (d) => this.projectDir(d) });
    engine.on('error', (e) => {
      console.error(e.stack || e);
      run.status = 'paused';
      run.note = `engine error: ${e.message}`;
      store.saveRun(run);
    });
    this.engines.set(run.id, engine);
    return engine;
  }

  list() { return store.listRuns(this.home).map((s) => (this.engines.has(s.id) ? { ...s, status: this.engines.get(s.id).run.status } : s)); }
  get(id) { if (!store.VALID_ID.test(id)) return null; if (this.engines.has(id)) return this.engines.get(id).run; try { return store.loadRun(this.home, id); } catch { return null; } }
  engine(id) { if (!store.VALID_ID.test(id)) return null; return this.engines.get(id) || null; }

  checkParams(tpl, params) {
    const errs = [];
    for (const [k, p] of Object.entries(tpl.params || {})) {
      const v = params[k];
      if (p.required && (v === undefined || v === '')) errs.push({ path: `params.${k}`, message: 'required' });
      if (v !== undefined && p.type === 'number' && Number.isNaN(Number(v))) errs.push({ path: `params.${k}`, message: 'must be a number' });
      if (v !== undefined && v !== '' && p.pattern && !new RegExp(p.pattern).test(String(v))) errs.push({ path: `params.${k}`, message: `must match ${p.pattern}` });
    }
    return errs;
  }
  // template param defaults, overridden by what the caller passed
  withDefaults(tpl, params = {}) {
    const out = {};
    for (const [k, p] of Object.entries(tpl.params || {})) if (p.default !== undefined) out[k] = p.default;
    return { ...out, ...params };
  }
  // sub-dirs of projects_root that look like a project (git repo or maven module)
  listProjects() {
    const root = this.config.projects_root;
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root).filter((n) => fs.existsSync(path.join(root, n, '.git')) || fs.existsSync(path.join(root, n, 'pom.xml'))).sort();
  }
  resolveItems(tpl, items = []) {
    const source = tpl.items?.source || 'manual';
    if (source === 'queue') {
      // items already held by a live run are left to it; a dead or missing run frees them
      const busy = (it) => it.runId && !['done', 'aborted'].includes(this.get(it.runId)?.status ?? 'aborted');
      return queue.open(this.home, tpl.items.queue).filter((it) => !busy(it))
        .map((it) => ({ name: it.id, queue: it.queue, text: it.text, link: it.link, createdAt: it.createdAt, snoozes: it.snoozes }));
    }
    if (!items.length) items = tpl.items?.default || [];
    if (!items.length && source === 'dirs') {
      throw new Error(`template ${tpl.name} takes projects from ${this.config.projects_root} — pass --items a,b (available: ${this.listProjects().join(', ') || 'none'})`);
    }
    return items.map((raw) => {
      const it = typeof raw === 'string' ? { name: raw } : { ...raw };
      if (!store.validName(it.name)) throw new Error(`invalid item name: ${JSON.stringify(it.name ?? null)}`);
      if (it.dir !== undefined && !this.projectDir(it.dir)) throw new Error(`item ${it.name}: dir must be an existing directory under ${this.config.projects_root}`);
      if (!it.dir) {
        const candidate = path.join(this.config.projects_root, it.name);
        if (fs.existsSync(candidate)) it.dir = candidate;
        else if (source === 'dirs') throw new Error(`project dir not found: ${candidate}`);
      }
      return it;
    });
  }
  // an item's working directory must stay inside projects_root (items may come from a step's output)
  projectDir(dir) {
    const root = path.resolve(this.config.projects_root);
    const abs = path.resolve(root, String(dir));
    return abs.startsWith(root + path.sep) && fs.existsSync(abs) ? abs : null;
  }
  // what the user confirms when trusting a template: every command it may run, plus its sidecar scripts
  templateCommands(t) {
    const body = (s) => s.shell ?? s.js ?? s.agent?.prompt.split('\n')[0] ?? s.human?.question;
    const expr = (s, k, v) => v !== undefined && `${s.name} ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`;
    return t.tpl.steps.flatMap((s) => [`${s.name} [${bodyKind(s)}${s.outbound ? ', outbound' : ''}]: ${body(s)}`,
      expr(s, 'check', s.check), expr(s, 'verify', s.verify), expr(s, 'when', s.when), expr(s, 'items', s.items),
      expr(s, 'cwd', s.cwd), expr(s, 'resource', s.resource), expr(s, 'input', s.agent?.input),
      ...(s.on_fail || []).filter((r) => r.do === 'agent').map((r) => expr(s, 'on_fail agent', r.prompt.split('\n')[0]))])
      .filter(Boolean).concat((t.sidecars || []).map((p) => `sidecar: ${p}`));
  }
  trustFile() { return path.join(this.home, 'trusted.json'); }
  trusted(name, hash) { try { return JSON.parse(fs.readFileSync(this.trustFile(), 'utf8'))[name] === hash; } catch { return false; } }
  trust(name, hash) {
    let all = {}; try { all = JSON.parse(fs.readFileSync(this.trustFile(), 'utf8')); } catch { /* first time */ }
    all[name] = hash;
    fs.writeFileSync(this.trustFile(), JSON.stringify(all, null, 2), { mode: 0o600 });
  }

  async create({ templateName, params = {}, items = [], mode = 'all', initiator = { via: 'cli', user: os.userInfo().username } }) {
    const t = this.templates.get(templateName);
    if (!t) throw new Error(`template not found: ${templateName}`);
    params = this.withDefaults(t.tpl, params);
    const perr = this.checkParams(t.tpl, params);
    if (perr.length) throw new Error(`invalid params: ${perr.map((e) => `${e.path} ${e.message}`).join(', ')}`);
    if (t.tpl.modes && !t.tpl.modes.includes(mode)) throw new Error(`mode ${mode} not allowed for ${templateName}`);
    const resolved = this.resolveItems(t.tpl, items);   // cheap input errors first, the trust question last
    if (!this.trusted(templateName, t.hash)) throw new NeedsTrust(templateName, t.hash, this.templateCommands(t));
    const run = store.createRun(this.home, { template: t, params, items: resolved, mode, initiator });
    if (t.tpl.items?.source === 'queue') for (const it of run.items) queue.take(this.home, it.queue, it.name, run.id);
    this.attach(run).start();
    return run;
  }

  clean(days = this.config.logs.retention_days) {
    if (typeof days !== 'number' || !Number.isFinite(days) || days < 0) throw new Error(`days must be a non-negative number, got ${JSON.stringify(days)}`);
    const cutoff = Date.now() - days * 86400_000;
    let removed = 0;
    for (const s of store.listRuns(this.home)) {
      const updated = Date.parse(s.updatedAt);
      if (!['done', 'aborted'].includes(s.status) || !Number.isFinite(updated) || updated > cutoff) continue;
      fs.rmSync(path.join(store.runsDir(this.home), s.id), { recursive: true, force: true });
      this.engines.delete(s.id); removed++;
    }
    return removed;
  }
}

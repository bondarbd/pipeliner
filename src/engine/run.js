import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import * as store from './store.js';
import { buildCtx } from './context.js';
import { render } from '../expr.js';
import { createMasker } from '../secrets.js';
import * as locks from './locks.js';
import { killGroup, isAlive } from './proc.js';
import { bodyKind } from '../template/validate.js';

export const DONE = new Set(['success', 'skipped', 'n/a']);
const STUCK = new Set(['paused', 'failed', 'interrupted', 'unverified']);
const TERMINAL_RUN = new Set(['done', 'aborted']);

export class Engine extends EventEmitter {
  constructor({ run, config, runners, envValues = {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    super();
    this.run = run; this.config = config; this.runners = runners; this.envValues = envValues; this.sleep = sleep;
    this.masker = createMasker(Object.values(envValues));
    this.active = new Map();     // "item:step" -> { step, agent, pid }
    this.timers = new Set();
    this.ticking = false; this.tickQueued = false;
    this.idleWaiters = [];
  }

  // ---- helpers
  get steps() { return this.run.steps; }
  item(name) { return this.run.items.find((i) => i.name === name); }
  cell(item, step) { return store.itemCell(this.run, item ? item.name : null, step.name); }
  key(item, step) { return `${item ? item.name : '*'}:${step.name}`; }
  activeItems() { return this.run.items.filter((i) => i.status === 'active'); }
  *allCells() {
    for (const s of this.steps) {
      if (s.once) yield [null, s, store.itemCell(this.run, null, s.name)];
      else for (const it of this.run.items) yield [it.name, s, store.itemCell(this.run, it.name, s.name)];
    }
  }
  pos(item) {
    for (let i = 0; i < this.steps.length; i++) {
      const s = this.steps[i];
      const c = s.once ? store.itemCell(this.run, null, s.name) : this.cell(item, s);
      if (!DONE.has(c.status)) return i;
    }
    return this.steps.length;
  }
  changed(ev) {
    if (ev) store.addEvent(this.run, ev);
    store.saveRun(this.run);
    this.emit('change', this.run);
  }
  exprCtx(item, step, output) {
    return buildCtx({ run: this.run, item, config: this.config, env: this.envFor(step), output });
  }
  envFor(step) {
    const out = {};
    for (const k of step.env || []) if (k in this.envValues) out[k] = this.envValues[k];
    return out;
  }
  rctx(item, step, c, exprCtx) {
    const p = store.paths(this.run, item ? item.name : null);
    const outDir = p.outDir(step.name, c.seq);
    fs.mkdirSync(outDir, { recursive: true });
    return {
      run: this.run, item, step, config: this.config, exprCtx, env: this.envFor(step),
      cwd: step.cwd ? render(step.cwd, exprCtx) : (item && item.dir) || this.run.dir,
      outDir, logPath: p.logPath(step.name, c.seq),
      timeout: step.timeout || (step.agent ? this.config.agent.timeout : 3600),
      masker: this.masker,
      notes: store.readNotes(this.run, item ? item.name : null, 8192),
      pilotNotes: item && this.run.pilot && item.name !== this.run.pilot.item ? this.run.pilotNotes : null,
      templateDir: this.run.templateDir, itemCtxDir: p.ctxDir, runCtxDir: store.paths(this.run, null).ctxDir,
      onSpawn: (pid) => { c.pid = pid; const a = this.active.get(this.key(item, step)); if (a) a.pid = pid; store.saveRun(this.run); },
      countAgentCall: () => { this.run.budgets.agentCalls++; },
    };
  }

  // ---- lifecycle
  start() { this.scheduleTick(); return this; }
  scheduleTick() {
    if (this.tickQueued) return;
    this.tickQueued = true;
    setImmediate(() => { this.tickQueued = false; this.tick().catch((e) => this.emit('error', e)); });
  }
  idle() { return new Promise((res) => { this.idleWaiters.push(res); setImmediate(() => this.checkIdle()); }); }
  checkIdle() {
    if (this.active.size || this.timers.size || this.tickQueued || this.ticking) return;
    const w = this.idleWaiters; this.idleWaiters = [];
    w.forEach((f) => f());
  }

  async tick() {
    if (this.ticking) { this.scheduleTick(); return; }
    this.ticking = true;
    try {
      if (TERMINAL_RUN.has(this.run.status)) return;
      this.checkRunTimeout();
      if (!this.run.pausedByUser && !this.budgetExceeded()) this.startRunnable();
      this.updateRunStatus();
    } finally {
      this.ticking = false;
      this.checkIdle();
    }
  }

  // Task 13 fills these two in; part 1 keeps them inert.
  checkRunTimeout() {}
  budgetExceeded() { return false; }

  startRunnable() {
    const items = this.activeItems();
    const positions = new Map(items.map((it) => [it.name, this.pos(it)]));
    this.pilotGate(items, positions);
    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i];
      if (step.once) { this.maybeStartOnce(step, i, items, positions); continue; }
      for (const item of items) {
        if (positions.get(item.name) !== i) continue;
        if (this.run.pilot && this.run.pilot.status !== 'approved' && item.name !== this.run.pilot.item) continue;
        const c = this.cell(item, step);
        if (c.status !== 'pending' || c.retryAt) continue;
        if (!this.hasSlot(step)) continue;
        this.launch(item, step);
      }
    }
  }
  // Task 12 implements these two; part 1 stubs keep once-steps from starting.
  pilotGate() {}
  maybeStartOnce() {}

  hasSlot(step) {
    const running = [...this.active.values()];
    if (running.length >= this.config.limits.parallel) return false;
    if (step.parallel && running.filter((a) => a.step === step.name).length >= step.parallel) return false;
    if (step.agent && running.filter((a) => a.agent).length >= this.config.agent.max_parallel) return false;
    return true;
  }

  launch(item, step) {
    const key = this.key(item, step);
    this.active.set(key, { step: step.name, agent: !!step.agent, pid: null });
    this.execCell(item, step)
      .catch((e) => {
        const c = this.cell(item, step);
        c.status = 'paused'; c.error = `engine error: ${e.message}`;
        this.changed({ type: 'cell.error', item: item?.name, step: step.name, error: e.message });
      })
      .finally(() => { this.active.delete(key); this.scheduleTick(); });
  }

  async execCell(item, step) {
    const c = this.cell(item, step);
    const ctx = this.exprCtx(item, step);
    if (step.when !== undefined && !render(step.when, ctx)) {
      c.status = 'skipped'; c.error = 'when: false';
      this.changed({ type: 'cell.skipped', item: item?.name, step: step.name });
      return;
    }
    if (c.attempts >= this.config.limits.max_attempts) {
      c.status = 'paused'; c.error = `budget: max_attempts (${this.config.limits.max_attempts})`;
      this.changed({ type: 'cell.budget', item: item?.name, step: step.name });
      return;
    }
    c.attempts++; c.seq = store.nextSeq(this.run); c.status = 'running';
    c.startedAt = new Date().toISOString(); c.error = null; c.waiting = null; c.note = null;
    const r = this.rctx(item, step, c, ctx);
    this.changed({ type: 'cell.started', item: item?.name, step: step.name, attempt: c.attempts, seq: c.seq });
    let lockHeld = null;
    try {
      lockHeld = await this.takeLock(step, ctx, c);
      if (await this.runCheck(item, step, c, r)) return;
      const res = await this.runners[bodyKind(step)].run(step, r);
      c.command = res.command || c.command; c.pid = null;
      if (res.waiting) { c.status = 'waiting'; c.waiting = res.waiting; c.needInput = false; this.changed({ type: 'cell.waiting', item: item?.name, step: step.name }); return; }
      if (res.needInput) { c.status = 'waiting'; c.waiting = { question: res.needInput, options: [], fields: ['answer'] }; c.needInput = true; this.changed({ type: 'cell.need_input', item: item?.name, step: step.name }); return; }
      if (!res.ok) {
        c.error = res.error || 'failed';
        if (res.dirtyAfterKill) { c.status = 'paused'; c.noRetry = true; c.error = `dirty_after_kill: ${c.error}`; this.changed({ type: 'cell.paused', item: item?.name, step: step.name, error: c.error }); return; }
        await this.applyLadder(item, step, c, r);
        return;
      }
      if (!(await this.runVerify(item, step, c, r))) { await this.applyLadder(item, step, c, r); return; }
      this.finishSuccess(item, step, c, res.output || {}, 'run');
    } finally {
      if (lockHeld) locks.release(this.config.home, lockHeld, this.run.id);
    }
  }
  // Task 13 implements these three; part 1 versions are pass-through.
  async takeLock() { return null; }
  async runCheck() { return false; }
  async runVerify() { return true; }

  // Task 11 replaces this with the ladder; part 1: always pause.
  async applyLadder(item, step, c) {
    c.status = 'paused';
    this.changed({ type: 'cell.paused', item: item?.name, step: step.name, error: c.error });
  }

  finishSuccess(item, step, c, output, how) {
    c.status = 'success'; c.output = output; c.finishedAt = new Date().toISOString(); c.waiting = null;
    store.saveStepOutput(this.run, item ? item.name : null, step.name, output);
    if (step.items !== undefined && step.once) this.produceItems(step, output);
    this.changed({ type: 'cell.success', item: item?.name, step: step.name, how });
  }
  produceItems() {} // Task 12

  updateRunStatus() {
    const run = this.run;
    if (TERMINAL_RUN.has(run.status)) return;
    const cells = [...this.allCells()].map(([, , c]) => c);
    const waiting = cells.some((c) => c.status === 'waiting') || run.pilot?.status === 'waiting';
    const running = this.active.size > 0 || this.timers.size > 0 || cells.some((c) => c.status === 'running');
    const items = this.activeItems();
    const finished = items.every((it) => this.pos(it) === this.steps.length)
      && this.steps.filter((s) => s.once).every((s) => DONE.has(store.itemCell(run, null, s.name).status));
    let status;
    if (running) status = 'running';
    else if (waiting) status = 'waiting_for_human';
    else if (finished) status = 'done';
    else status = 'paused';
    if (status !== run.status) {
      run.status = status;
      if (status === 'done') run.finishedAt = new Date().toISOString();
      this.changed({ type: 'run.status', status });
    }
  }
}

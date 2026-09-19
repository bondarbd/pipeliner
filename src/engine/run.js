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

  checkRunTimeout() {
    if (this.run.pausedByUser) return;
    const age = Date.now() - Date.parse(this.run.createdAt);
    if (age > this.config.limits.run_timeout * 1000) {
      this.run.pausedByUser = true; this.run.note = 'budget: run_timeout exceeded — resume to continue';
      this.changed({ type: 'run.timeout' });
    }
  }
  budgetExceeded() {
    if (this.run.budgets.agentCalls < this.config.limits.max_agent_calls) return false;
    if (!this.run.pausedByUser) {
      this.run.pausedByUser = true; this.run.note = `budget: max_agent_calls (${this.config.limits.max_agent_calls}) exhausted — resume to continue`;
      this.changed({ type: 'run.budget' });
    }
    return true;
  }

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
  pilotGate(items, positions) {
    const p = this.run.pilot;
    if (!p || p.status !== 'running') return;
    const pilot = items.find((i) => i.name === p.item);
    if (!pilot) { p.status = 'approved'; this.changed({ type: 'pilot.auto_approved' }); return; }
    const firstOnce = this.steps.findIndex((s) => s.once);
    const limit = firstOnce === -1 ? this.steps.length : firstOnce;
    if (positions.get(pilot.name) >= limit) { p.status = 'waiting'; this.changed({ type: 'pilot.waiting' }); }
  }

  maybeStartOnce(step, i, items, positions) {
    const c = store.itemCell(this.run, null, step.name);
    if (c.status !== 'pending' || c.retryAt) return;
    if (this.run.pilot && this.run.pilot.status !== 'approved') return;
    const policy = step.barrier || 'all';
    const blockers = items.filter((it) => {
      const p = positions.get(it.name);
      if (p >= i) return false;
      if (policy === 'succeeded') { const cur = this.cell(it, this.steps[p]); return !STUCK.has(cur.status); }
      return true;
    });
    if (blockers.length || !this.hasSlot(step)) return;
    this.launch(null, step);
  }

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
    } catch (e) {
      if (e instanceof locks.LockBusy) { c.status = 'paused'; c.error = e.message; c.attempts--; this.changed({ type: 'cell.lock_busy', item: item?.name, step: step.name, error: e.message }); return; }
      throw e;
    } finally {
      if (lockHeld) locks.release(this.config.home, lockHeld, this.run.id);
    }
  }
  async takeLock(step, ctx, c) {
    if (!step.resource) return null;
    const res = render(step.resource, ctx);
    c.note = `waiting for lock ${res}`;
    try { await locks.acquire(this.config.home, res, { owner: this.run.id, waitMs: this.config.limits.lock_wait * 1000 }); }
    finally { c.note = null; }
    return res;
  }
  async runCheck(item, step, c, r) {
    if (!step.check) return false;
    const chk = await this.runners.shell.run({ name: `${step.name}#check`, shell: step.check, output: step.output || 'keys' }, { ...r, logPath: r.logPath.replace(/\.log$/, '.check.log') });
    if (!chk.ok) return false;
    this.finishSuccess(item, step, c, chk.output || {}, 'check');
    return true;
  }
  async runVerify(item, step, c, r) {
    if (!step.verify) return true;
    const v = await this.runners.shell.run({ name: `${step.name}#verify`, shell: step.verify, output: 'text' }, { ...r, logPath: r.logPath.replace(/\.log$/, '.verify.log') });
    if (v.ok) return true;
    c.status = 'unverified'; c.error = `verify failed: ${v.error}`;
    this.changed({ type: 'cell.unverified', item: item?.name, step: step.name, error: c.error });
    return false;
  }

  async recover() {
    for (const [itemName, step, c] of this.allCells()) {
      if (c.status === 'running') {
        if (c.pid && isAlive(c.pid)) await killGroup(c.pid);
        c.status = 'interrupted'; c.error = 'panel restarted during this step'; c.pid = null;
      }
      if (c.status === 'pending' && c.retryAt) c.retryAt = null;
      if (c.status === 'waiting' && c.needInput === false && !step.human) { c.status = 'interrupted'; c.error = 'panel restarted while waiting'; }
    }
    if (this.run.status === 'running') this.run.status = 'paused';
    this.changed({ type: 'run.recovered' });
    for (const [itemName, step, c] of this.allCells()) {
      if (c.status !== 'interrupted' || !step.check) continue;
      const item = itemName ? this.item(itemName) : null;
      c.seq = store.nextSeq(this.run);
      const r = this.rctx(item, step, c, this.exprCtx(item, step));
      await this.runCheck(item, step, c, r);
    }
    return this.start();
  }

  async applyLadder(item, step, c, r) {
    const rungs = step.on_fail || [{ do: 'pause' }];
    const pause = () => { c.status = 'paused'; this.changed({ type: 'cell.paused', item: item?.name, step: step.name, error: c.error }); };
    while (c.rung < rungs.length) {
      const rung = rungs[c.rung];
      if (rung.do === 'retry') {
        if (c.retriesUsed < rung.times) {
          c.retriesUsed++; c.status = 'pending';
          const delayMs = (rung.delay || 0) * 1000;
          this.changed({ type: 'cell.retry_scheduled', item: item?.name, step: step.name, delayMs });
          if (delayMs) {
            c.retryAt = Date.now() + delayMs;
            const t = setTimeout(() => { this.timers.delete(t); c.retryAt = null; this.scheduleTick(); }, delayMs);
            this.timers.add(t);
          }
          return;
        }
        c.rung++; continue;
      }
      if (rung.do === 'agent') {
        if (!c.diagnosed) {
          c.diagnosed = true; c.note = 'diagnosing';
          this.changed({ type: 'cell.diagnose', item: item?.name, step: step.name });
          const diag = { name: `${step.name}#diagnose`, agent: { prompt: rung.prompt, readonly: true }, output: 'text' };
          try { await this.runners.agent.run(diag, { ...r, logPath: r.logPath.replace(/\.log$/, '.diagnose.log') }); }
          catch (e) { store.addEvent(this.run, { type: 'cell.diagnose_failed', item: item?.name, step: step.name, error: e.message }); }
          c.note = null;
        }
        if (rung.then === 'pause') { pause(); return; }
        c.rung++; continue;
      }
      if (rung.do === 'pause') { pause(); return; }
      if (rung.do === 'skip_item') {
        c.status = 'skipped'; if (item) item.status = 'skipped';
        this.changed({ type: 'item.skipped', item: item?.name, step: step.name, error: c.error });
        return;
      }
      if (rung.do === 'abort') { c.status = 'failed'; await this.abort(`step ${step.name} failed on ${item ? item.name : 'run'}: ${c.error}`); return; }
      c.rung++;
    }
    pause();
  }

  // ---- user actions
  retry(itemName, stepName) {
    const c = store.itemCell(this.run, itemName, stepName);
    if (!['paused', 'interrupted', 'unverified', 'failed', 'skipped'].includes(c.status)) throw new Error(`cannot retry cell in status ${c.status}`);
    if (c.noRetry) throw new Error(`retry blocked: ${c.error}`);
    c.status = 'pending'; c.error = null; c.retryAt = null;
    if (itemName) { const it = this.item(itemName); if (it.status !== 'active') it.status = 'active'; }
    if (this.run.status === 'done') this.run.status = 'running';
    this.changed({ type: 'cell.retry', item: itemName, step: stepName, by: 'user' });
    this.scheduleTick();
  }
  skipCell(itemName, stepName) {
    const c = store.itemCell(this.run, itemName, stepName);
    if (!['paused', 'interrupted', 'unverified', 'failed', 'pending', 'waiting'].includes(c.status)) throw new Error(`cannot skip cell in status ${c.status}`);
    c.status = 'skipped'; c.waiting = null;
    this.changed({ type: 'cell.skip', item: itemName, step: stepName, by: 'user' });
    this.scheduleTick();
  }
  async killCell(c) { if (c.pid) { await killGroup(c.pid); c.pid = null; } }
  abortItem(itemName) {
    const it = this.item(itemName);
    it.status = 'aborted';
    for (const s of this.steps) if (s.each) {
      const c = this.cell(it, s);
      if (!DONE.has(c.status)) { if (c.status === 'running') this.killCell(c); c.status = 'failed'; c.waiting = null; }
    }
    this.changed({ type: 'item.aborted', item: itemName, by: 'user' });
    this.scheduleTick();
  }
  async abort(reason) {
    this.run.status = 'aborted'; this.run.note = reason;
    for (const a of this.active.values()) if (a.pid) await killGroup(a.pid);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.changed({ type: 'run.aborted', reason });
  }
  pauseRun() { this.run.pausedByUser = true; this.changed({ type: 'run.pause', by: 'user' }); }
  resumeRun() { this.run.pausedByUser = false; this.run.note = null; this.changed({ type: 'run.resume', by: 'user' }); this.scheduleTick(); }

  finishSuccess(item, step, c, output, how) {
    c.status = 'success'; c.output = output; c.finishedAt = new Date().toISOString(); c.waiting = null;
    store.saveStepOutput(this.run, item ? item.name : null, step.name, output);
    if (step.items !== undefined && step.once) this.produceItems(step, output);
    this.changed({ type: 'cell.success', item: item?.name, step: step.name, how });
  }
  produceItems(step, output) {
    const list = render(step.items, this.exprCtx(null, step, output));
    if (!Array.isArray(list)) throw new Error(`items: expression of step ${step.name} must return an array`);
    const idx = this.steps.indexOf(step);
    const existing = new Set(this.run.items.map((i) => i.name));
    let added = 0;
    for (const raw of list) {
      if (!raw || !raw.name || existing.has(raw.name)) continue;
      existing.add(raw.name);
      const it = { status: 'active', ...raw };
      this.run.items.push(it);
      for (let k = 0; k <= idx; k++) if (this.steps[k].each) store.itemCell(this.run, it.name, this.steps[k].name).status = 'n/a';
      for (let k = idx + 1; k < this.steps.length; k++) if (this.steps[k].each) store.itemCell(this.run, it.name, this.steps[k].name);
      added++;
    }
    if (list.length > 50) { this.run.pausedByUser = true; this.run.note = `step ${step.name} produced ${list.length} items — resume the run to continue`; }
    store.addEvent(this.run, { type: 'items.added', step: step.name, count: added });
  }

  answer(itemName, stepName, { answer, fields = {} } = {}) {
    if (itemName === '__pilot__') {
      const p = this.run.pilot;
      if (!p || p.status !== 'waiting') throw new Error('pilot is not waiting');
      p.status = ['Да', 'yes', 'Yes', 'да'].includes(answer) ? 'approved' : 'rejected';
      if (p.status === 'approved') this.run.pilotNotes = store.readNotes(this.run, p.item, 8192) || null;
      store.appendNotes(this.run, null, `pilot ${p.item}: ${answer}`, 'human');
      this.changed({ type: `pilot.${p.status}`, by: 'user' });
      this.scheduleTick();
      return;
    }
    const c = store.itemCell(this.run, itemName, stepName);
    if (c.status !== 'waiting') throw new Error(`cell ${itemName ?? '*'}:${stepName} is not waiting`);
    const extra = Object.keys(fields).length ? `\n${JSON.stringify(fields)}` : '';
    store.appendNotes(this.run, itemName, `Q: ${c.waiting.question}\nA: ${answer}${extra}`, 'human');
    if (c.needInput) {
      c.status = 'pending'; c.needInput = false; c.waiting = null; c.attempts--;
      this.changed({ type: 'cell.input_given', item: itemName, step: stepName });
      this.scheduleTick();
      return;
    }
    const step = this.steps.find((s) => s.name === stepName);
    const pauseOn = step.human?.pause_on || ['Нет', 'No', 'no', 'нет'];
    c.waiting = null;
    if (pauseOn.includes(answer)) { c.status = 'paused'; c.error = `answer: ${answer}`; this.changed({ type: 'cell.paused', item: itemName, step: stepName, error: c.error }); }
    else this.finishSuccess(itemName ? this.item(itemName) : null, step, c, { answer, ...fields }, 'human');
    this.scheduleTick();
  }

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

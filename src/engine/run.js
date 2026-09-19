import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import * as store from './store.js';
import { buildCtx } from './context.js';
import { render } from '../expr.js';
import { createMasker, secretValues } from '../secrets.js';
import * as locks from './locks.js';
import { killGroup } from './proc.js';
import { bodyKind } from '../template/validate.js';

export const DONE = new Set(['success', 'skipped', 'n/a']);
const STUCK = new Set(['paused', 'failed', 'interrupted', 'unverified']);
const TERMINAL_RUN = new Set(['done', 'aborted']);
const RETRIABLE = ['paused', 'interrupted', 'unverified', 'failed', 'skipped'];
const SKIPPABLE = ['paused', 'interrupted', 'unverified', 'failed', 'pending', 'waiting'];
const YES = ['Да', 'да', 'Yes', 'yes'];
const NO = ['Нет', 'нет', 'No', 'no'];
const CONFIRM = [...YES, 'Отправить', 'Подтверждаю'];   // default answers that let an outbound step run
const MAX_QUESTIONS = 3;   // NEED_INPUT rounds per cell before the lane pauses instead of asking again

const now = () => new Date().toISOString();
// runner context for a helper command (check / verify / diagnose) of the same cell: own log file
const sub = (r, kind) => ({ ...r, logPath: r.logPath.replace(/\.log$/, `.${kind}.log`) });

export class Engine extends EventEmitter {
  constructor({ run, config, runners, envValues = {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    super();
    this.run = run; this.config = config; this.runners = runners; this.envValues = envValues; this.sleep = sleep;
    this.masker = createMasker(secretValues(envValues));
    this.active = new Map();     // "item:step" -> { step, agent }
    this.idleSince = Date.now(); // run_timeout counts only time with running cells: idle stretches are credited back
    this.timers = new Set();
    this.ticking = false; this.tickQueued = false;
    this.idleWaiters = [];
  }

  // ---- helpers
  get steps() { return this.run.steps; }
  item(name) { return this.run.items.find((i) => i.name === name); }
  step(name) { return this.steps.find((s) => s.name === name); }
  cell(item, step) { return store.itemCell(this.run, item ? item.name : null, step.name); }
  key(item, step) { return `${item ? item.name : '*'}:${step.name}`; }
  aborted() { return this.run.status === 'aborted'; }
  activeItems() { return this.run.items.filter((i) => i.status === 'active'); }
  *allCells() {
    for (const s of this.steps) {
      if (s.once) yield [null, s, store.itemCell(this.run, null, s.name)];
      else for (const it of this.run.items) yield [it.name, s, store.itemCell(this.run, it.name, s.name)];
    }
  }
  pos(item) {
    const i = this.steps.findIndex((s) => !DONE.has((s.once ? store.itemCell(this.run, null, s.name) : this.cell(item, s)).status));
    return i === -1 ? this.steps.length : i;
  }
  changed(ev) {
    if (ev) store.addEvent(this.run, ev);
    store.saveRun(this.run);
    this.emit('change', this.run);
  }
  // closes a cell in a final (or paused) status and records the event
  finish(item, step, c, status, ev = {}) {
    c.status = status; c.finishedAt = now(); c.pid = null;
    if (c.startedAt) ev.durationMs = Date.parse(c.finishedAt) - Date.parse(c.startedAt);
    this.changed({ type: `cell.${status}`, item: item?.name, step: step.name, error: c.error || undefined, ...ev });
  }
  pause(note, type) {
    this.run.pausedByUser = true; this.run.note = note;
    this.changed({ type });
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
      onSpawn: (pid) => { c.pid = pid; store.saveRun(this.run); },
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
      if (!this.checkBudgets()) this.startRunnable();
      this.updateRunStatus();
    } finally {
      this.ticking = false;
      this.checkIdle();
    }
  }

  isFinished() {
    return this.activeItems().every((it) => this.pos(it) === this.steps.length)
      && this.steps.filter((s) => s.once).every((s) => DONE.has(store.itemCell(this.run, null, s.name).status));
  }
  // true when nothing new may start: paused by the user, or a run-wide budget just tripped
  checkBudgets() {
    if (this.run.pausedByUser || this.isFinished()) return this.run.pausedByUser;
    const { limits } = this.config; const b = this.run.budgets;
    // the wall-clock budget only counts while something is executing: a run waiting for a human all day is fine
    if (this.active.size && Date.now() - Date.parse(b.since) > limits.run_timeout * 1000) this.pause('budget: run_timeout exceeded — resume to continue', 'run.timeout');
    else if (b.agentCalls >= limits.max_agent_calls) this.pause(`budget: max_agent_calls (${limits.max_agent_calls}) exhausted — resume to continue`, 'run.budget');
    return this.run.pausedByUser;
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
        if (c.status === 'pending' && !c.retryAt && this.hasSlot(step)) this.launch(item, step);
      }
    }
  }
  pilotGate(items, positions) {
    const p = this.run.pilot;
    if (!p || p.status !== 'running') return;
    const pilot = items.find((i) => i.name === p.item);
    const firstOnce = this.steps.findIndex((s) => s.once);
    const limit = firstOnce === -1 ? this.steps.length : firstOnce;
    if (!pilot || limit === 0) { p.status = 'approved'; this.changed({ type: 'pilot.auto_approved' }); return; }
    if (positions.get(pilot.name) >= limit) { p.status = 'waiting'; this.changed({ type: 'pilot.waiting' }); }
  }

  maybeStartOnce(step, i, items, positions) {
    const c = store.itemCell(this.run, null, step.name);
    if (c.status !== 'pending' || c.retryAt) return;
    if (this.run.pilot && this.run.pilot.status !== 'approved') return;
    const blocked = items.some((it) => {
      const p = positions.get(it.name);
      if (p >= i) return false;
      return step.barrier !== 'succeeded' || !STUCK.has(this.cell(it, this.steps[p]).status);
    });
    if (!blocked && this.hasSlot(step)) this.launch(null, step);
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
    if (!this.active.size) {   // leaving idle: move the budget clock forward by the time nothing ran
      const b = this.run.budgets;
      b.since = new Date(Date.parse(b.since) + (Date.now() - this.idleSince)).toISOString();
    }
    this.active.set(key, { step: step.name, agent: !!step.agent });
    this.execCell(item, step)
      .catch((e) => { const c = this.cell(item, step); c.error = `engine error: ${e.message}`; this.finish(item, step, c, 'paused'); })
      .finally(() => { this.active.delete(key); if (!this.active.size) this.idleSince = Date.now(); this.scheduleTick(); });
  }

  async execCell(item, step) {
    const c = this.cell(item, step);
    const ctx = this.exprCtx(item, step);
    if (step.when !== undefined && !render(step.when, ctx)) { c.error = 'when: false'; return this.finish(item, step, c, 'skipped'); }
    if (step.outbound) {   // a step that talks to people runs only after the human said yes on the step right before it
      const answer = this.cell(item, this.steps[this.steps.indexOf(step) - 1]).output?.answer;
      const accepted = Array.isArray(step.outbound) ? step.outbound : CONFIRM;
      if (!accepted.includes(answer)) { c.error = `outbound: not confirmed (${answer ?? 'no answer'})`; return this.finish(item, step, c, 'skipped'); }
    }
    if (c.attempts >= this.config.limits.max_attempts) { c.error = `budget: max_attempts (${this.config.limits.max_attempts})`; return this.finish(item, step, c, 'paused'); }
    c.attempts++; c.seq = store.nextSeq(this.run); c.status = 'running';
    c.startedAt = now(); c.finishedAt = null; c.error = null; c.waiting = null; c.note = null;
    const r = this.rctx(item, step, c, ctx);
    this.changed({ type: 'cell.started', item: item?.name, step: step.name, attempt: c.attempts, seq: c.seq });
    let lock = null;
    try {
      if (step.resource) {
        const res = render(step.resource, ctx);
        c.note = `waiting for lock ${res}`; this.changed();
        try { await locks.acquire(this.config.home, res, { owner: this.run.id, waitMs: this.config.limits.lock_wait * 1000 }); lock = res; }
        catch (e) { if (!(e instanceof locks.LockBusy)) throw e; c.attempts--; c.error = e.message; return this.finish(item, step, c, 'paused'); }
        finally { c.note = null; }
      }
      if (this.aborted() || await this.runCheck(item, step, c, r) || this.aborted()) return;
      const res = await this.runners[bodyKind(step)].run(step, r);
      if (this.aborted()) return;
      if (res.command) c.command = this.masker.mask(res.command);
      c.pid = null;
      if (res.needInput && ++c.questions > MAX_QUESTIONS) {
        c.error = `agent asked for input ${c.questions} times, last: ${res.needInput}`;
        return this.finish(item, step, c, 'paused', { code: res.code });
      }
      if (res.waiting || res.needInput) {
        c.status = 'waiting'; c.needInput = !!res.needInput;
        c.waiting = res.waiting || { question: res.needInput, options: [], fields: [] };
        return this.changed({ type: 'cell.waiting', item: item?.name, step: step.name });
      }
      if (!res.ok) {
        c.error = res.error || 'failed';
        if (!res.dirtyAfterKill) return this.applyLadder(item, step, c, r, res);
        c.noRetry = true; c.error = `dirty_after_kill: ${c.error}`;
        return this.finish(item, step, c, 'paused', { code: res.code });
      }
      if (step.verify) {
        const v = await this.runners.shell.run({ name: `${step.name}#verify`, shell: step.verify, output: 'text' }, sub(r, 'verify'));
        if (this.aborted()) return;
        if (!v.ok) { c.error = `verify failed: ${v.error}`; this.finish(item, step, c, 'unverified', { code: v.code }); return this.applyLadder(item, step, c, r, res); }
      }
      this.finishSuccess(item, step, c, res.output || {}, 'run', res);
    } finally {
      if (lock) locks.release(this.config.home, lock, this.run.id);
    }
  }
  // idempotency probe: a passing `check` finishes the cell without running the body
  async runCheck(item, step, c, r) {
    if (!step.check) return false;
    const chk = await this.runners.shell.run({ name: `${step.name}#check`, shell: step.check, output: step.output || 'keys' }, sub(r, 'check'));
    if (chk.ok) this.finishSuccess(item, step, c, chk.output || {}, 'check', chk);
    return chk.ok;
  }

  async recover() {
    for (const [, step, c] of this.allCells()) {
      if (c.status === 'running' || (c.status === 'waiting' && !c.needInput && !step.human)) {
        c.status = 'interrupted'; c.error = 'panel restarted during this step'; c.orphanPid = c.pid; c.pid = null;
      }
      c.retryAt = null;
    }
    if (this.run.status === 'running') this.run.status = 'paused';
    this.run.budgets.since = now();   // downtime is not execution time
    this.changed({ type: 'run.recovered' });
    for (const [itemName, step, c] of this.allCells()) {
      if (c.status !== 'interrupted' || !step.check) continue;
      const item = itemName ? this.item(itemName) : null;
      c.seq = store.nextSeq(this.run);
      await this.runCheck(item, step, c, this.rctx(item, step, c, this.exprCtx(item, step)));
    }
    return this.start();
  }

  async applyLadder(item, step, c, r, res) {
    const rungs = step.on_fail || [{ do: 'pause' }];
    while (!this.aborted()) {
      const rung = rungs[c.rung];
      if (!rung || rung.do === 'pause') return this.finish(item, step, c, 'paused', { code: res.code });
      if (rung.do === 'retry' && c.retriesUsed < rung.times) {
        c.retriesUsed++; c.status = 'pending';
        const delayMs = (rung.delay || 0) * 1000;
        if (delayMs) {
          c.retryAt = Date.now() + delayMs;
          const t = setTimeout(() => { this.timers.delete(t); c.retryAt = null; this.scheduleTick(); }, delayMs);
          this.timers.add(t);
        }
        return this.changed({ type: 'cell.retry_scheduled', item: item?.name, step: step.name, delayMs });
      }
      if (rung.do === 'agent') {
        if (!c.diagnosed) {
          c.diagnosed = true; c.note = 'diagnosing';
          this.changed({ type: 'cell.diagnose', item: item?.name, step: step.name });
          const diag = { name: `${step.name}#diagnose`, agent: { prompt: rung.prompt, readonly: true }, output: 'text' };
          try { await this.runners.agent.run(diag, sub(r, 'diagnose')); }
          catch (e) { store.addEvent(this.run, { type: 'cell.diagnose_failed', item: item?.name, step: step.name, error: e.message }); }
          c.note = null;
          if (this.aborted()) return;
        }
        if (rung.then === 'pause') return this.finish(item, step, c, 'paused', { code: res.code });
      }
      if (rung.do === 'skip_item') { if (item) item.status = 'skipped'; return this.finish(item, step, c, 'skipped'); }
      if (rung.do === 'abort') { this.finish(item, step, c, 'failed'); return this.abort(`step ${step.name} failed on ${item ? item.name : 'run'}: ${c.error}`); }
      c.rung++;
    }
  }

  finishSuccess(item, step, c, output, how, res) {
    if (step.items !== undefined) {
      try { this.produceItems(step, output); }
      catch (e) { c.error = `items: ${e.message}`; return this.finish(item, step, c, 'paused'); }
    }
    c.output = output; c.via = how; c.waiting = null;
    store.saveStepOutput(this.run, item ? item.name : null, step.name, output);
    this.finish(item, step, c, 'success', { how, code: res?.code });
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
      this.run.items.push({ status: 'active', addedAt: now(), ...raw });
      // each-steps up to and including the producer never ran for this item; later ones start pending
      this.steps.forEach((s, k) => { if (s.each) store.itemCell(this.run, raw.name, s.name).status = k <= idx ? 'n/a' : 'pending'; });
      added++;
    }
    if (list.length > 50) this.pause(`step ${step.name} produced ${list.length} items — resume the run to continue`, 'run.pause');
    store.addEvent(this.run, { type: 'items.added', step: step.name, count: added });
  }

  // ---- user actions
  userCell(itemName, stepName, allowed, what) {
    if (TERMINAL_RUN.has(this.run.status)) throw new Error(`run is ${this.run.status}`);
    const c = store.itemCell(this.run, itemName, stepName);
    if (!allowed.includes(c.status)) throw new Error(`cannot ${what} cell in status ${c.status}`);
    return c;
  }
  retry(itemName, stepName) {
    const c = this.userCell(itemName, stepName, RETRIABLE, 'retry');
    if (c.noRetry) throw new Error(`retry blocked: ${c.error}`);
    c.attempts = 0; c.questions = 0; c.status = 'pending'; c.error = null; c.retryAt = null;   // a user retry grants a fresh allowance
    if (itemName) this.item(itemName).status = 'active';
    if (this.run.status === 'done') this.run.status = 'running';
    this.changed({ type: 'cell.retry', item: itemName, step: stepName, by: 'user' });
    this.scheduleTick();
  }
  skipCell(itemName, stepName) {
    const c = this.userCell(itemName, stepName, SKIPPABLE, 'skip');
    c.waiting = null;
    this.finish(itemName ? this.item(itemName) : null, this.step(stepName), c, 'skipped', { by: 'user' });
    this.scheduleTick();
  }
  async failCell(c, error) {
    if (c.pid) await killGroup(c.pid);
    c.status = 'failed'; c.error ??= error; c.pid = null; c.waiting = null; c.finishedAt = now();
  }
  async abortItem(itemName) {
    const it = this.item(itemName);
    it.status = 'aborted';
    for (const s of this.steps) if (s.each && !DONE.has(this.cell(it, s).status)) await this.failCell(this.cell(it, s), 'item aborted');
    this.changed({ type: 'item.aborted', item: itemName, by: 'user' });
    this.scheduleTick();
  }
  async abort(reason) {
    this.run.status = 'aborted'; this.run.note = reason; this.run.finishedAt = now();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const [, , c] of this.allCells()) if (c.status === 'running') await this.failCell(c, 'run aborted');
    this.changed({ type: 'run.aborted', reason });
  }
  pauseRun() { this.pause(null, 'run.pause'); }
  resumeRun() {
    this.run.pausedByUser = false;
    // resuming after a budget pause grants a fresh allowance; +1s so a zero run_timeout doesn't re-trip on the next tick
    if (this.run.note?.startsWith('budget:')) this.run.budgets = { agentCalls: 0, since: new Date(Date.now() + 1000).toISOString() };
    this.run.note = null;
    this.changed({ type: 'run.resume', by: 'user' });
    this.scheduleTick();
  }

  answer(itemName, stepName, { answer, fields = {} } = {}) {
    if (TERMINAL_RUN.has(this.run.status)) throw new Error(`run is ${this.run.status}`);
    if (itemName === '__pilot__') return this.answerPilot(answer);
    const c = store.itemCell(this.run, itemName, stepName);
    if (c.status !== 'waiting') throw new Error(`cell ${itemName ?? '*'}:${stepName} is not waiting`);
    const options = c.waiting.options || [];
    if (!c.needInput && options.length && !options.includes(answer)) throw new Error(`answer must be one of: ${options.join(' | ')}`);
    const extra = Object.keys(fields).length ? `\n${JSON.stringify(fields)}` : '';
    store.appendNotes(this.run, itemName, `Q: ${c.waiting.question}\nA: ${answer}${extra}`, 'human');
    const step = this.step(stepName); const item = itemName ? this.item(itemName) : null;
    c.waiting = null;
    if (c.needInput) { c.status = 'pending'; c.needInput = false; c.attempts--; this.changed({ type: 'cell.input_given', item: itemName, step: stepName }); }
    else if ((step.human?.pause_on || NO).includes(answer)) { c.error = `answer: ${answer}`; this.finish(item, step, c, 'paused'); }
    else this.finishSuccess(item, step, c, { answer, ...fields }, 'human');
    this.scheduleTick();
  }
  answerPilot(answer) {
    const p = this.run.pilot;
    if (!p || p.status !== 'waiting') throw new Error('pilot is not waiting');
    store.appendNotes(this.run, null, `pilot ${p.item}: ${answer}`, 'human');
    if (YES.includes(answer)) {
      p.status = 'approved';
      this.run.pilotNotes = store.readNotes(this.run, p.item, 8192) || null;
      this.changed({ type: 'pilot.approved', by: 'user' });
    } else {
      p.status = 'running';
      this.pause('pilot rejected: fix the pilot item, then resume the run to be asked again', 'pilot.rejected');
    }
    this.scheduleTick();
  }

  updateRunStatus() {
    const run = this.run;
    if (TERMINAL_RUN.has(run.status)) return;
    const cells = [...this.allCells()].map(([, , c]) => c);
    let status = 'paused';
    if (this.active.size || this.timers.size || cells.some((c) => c.status === 'running')) status = 'running';
    else if (cells.some((c) => c.status === 'waiting') || run.pilot?.status === 'waiting') status = 'waiting_for_human';
    else if (this.isFinished()) status = 'done';
    if (status !== run.status) {
      run.status = status;
      if (status === 'done') run.finishedAt = now();
      this.changed({ type: 'run.status', status });
    }
  }
}

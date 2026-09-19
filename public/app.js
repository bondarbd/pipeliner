/* global Vue */
const { createApp } = Vue;

const tokenFromHash = () => {
  const m = location.hash.match(/[#&]t=([^&]+)/);
  if (m) { sessionStorage.setItem('rb_token', m[1]); history.replaceState(null, '', `${location.pathname}#/`); }
  return sessionStorage.getItem('rb_token') || '';
};

createApp({
  data() {
    return { view: 'templates', error: '', busy: false, templates: [], templateErrors: [], projects: [], sel: null, trust: null, previewRows: [],
      form: { params: {}, items: [], itemsJson: '', mode: 'all' }, runs: [], run: null, runId: null, drawer: null, logText: '', ctx: null, timer: null, token: tokenFromHash(),
      answerFields: {}, runsFilter: { template: '', status: '' } };
  },
  computed: {
    waitingCells() {
      if (!this.run) return [];
      const out = [];
      for (const s of this.run.steps) {
        if (s.once) { const key = `*:${s.name}`; const c = this.run.once[s.name]; if (c.status === 'waiting') out.push({ key, item: null, step: s.name, waiting: c.waiting, fields: this.ensureFields(key) }); continue; }
        for (const it of this.run.items) { const key = `${it.name}:${s.name}`; const c = this.run.cells[it.name]?.[s.name]; if (c?.status === 'waiting') out.push({ key, item: it.name, step: s.name, waiting: c.waiting, fields: this.ensureFields(key) }); }
      }
      return out;
    },
    runTemplates() { return [...new Set(this.runs.map((r) => r.templateName))]; },
    runStatuses() { return [...new Set(this.runs.map((r) => r.status))]; },
    filteredRuns() {
      return this.runs.filter((r) => (!this.runsFilter.template || r.templateName === this.runsFilter.template)
        && (!this.runsFilter.status || r.status === this.runsFilter.status));
    },
  },
  methods: {
    async api(method, p, body) {
      const res = await fetch(`/api${p}`, { method, headers: { 'content-type': 'application/json', 'x-runboard-token': this.token }, body: body ? JSON.stringify(body) : undefined });
      if (res.status === 204) return null;
      const text = await res.text();
      let j; try { j = JSON.parse(text); } catch { j = { text }; }
      if (!res.ok) { const e = new Error(j.error || `HTTP ${res.status}`); e.payload = j; throw e; }
      return j;
    },
    async guard(fn) { this.error = ''; try { return await fn(); } catch (e) { this.error = e.message; } },
    route() {
      const h = location.hash || '#/';
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      if (h.startsWith('#/run/')) { this.view = 'run'; this.runId = h.slice(6); this.drawer = null; this.ctx = null; this.loadRun(); this.timer = setInterval(() => this.loadRun(), 3000); }
      else if (h.startsWith('#/runs')) { this.view = 'runs'; this.loadRuns(); this.timer = setInterval(() => this.loadRuns(), 5000); }
      else { this.view = 'templates'; this.loadTemplates(); }
    },
    loadTemplates() { return this.guard(async () => { const d = await this.api('GET', '/templates'); this.templates = d.templates; this.templateErrors = d.errors; this.projects = await this.api('GET', '/projects'); }); },
    loadRuns() { return this.guard(async () => { this.runs = await this.api('GET', '/runs'); }); },
    loadRun() { return this.guard(async () => { this.run = await this.api('GET', `/runs/${this.runId}`); }); },
    pick(t) { this.sel = t; this.trust = null; this.previewRows = []; this.form = { params: Object.fromEntries(Object.entries(t.params).map(([k, p]) => [k, p.default ?? ''])), items: [], itemsJson: '', mode: t.modes[0] || 'all' }; },
    itemsPayload() { if ((this.sel.items.source || 'manual') === 'dirs') return this.form.items; return this.form.itemsJson.trim() ? JSON.parse(this.form.itemsJson) : []; },
    preview() { return this.guard(async () => { const { rows } = await this.api('POST', `/templates/${this.sel.name}/preview`, { params: this.form.params, items: this.itemsPayload(), mode: this.form.mode }); this.previewRows = rows; }); },
    launch() { return this.guard(async () => {
      this.busy = true;
      try { const { id } = await this.api('POST', '/runs', { template: this.sel.name, params: this.form.params, items: this.itemsPayload(), mode: this.form.mode }); location.hash = `#/run/${id}`; }
      catch (e) { if (e.payload?.needsTrust) this.trust = e.payload; else throw e; }
      finally { this.busy = false; }
    }); },
    doTrust() { return this.guard(async () => { await this.api('POST', `/templates/${this.trust.template}/trust`, { hash: this.trust.hash }); this.trust = null; await this.launch(); }); },
    act(a) { return this.guard(async () => { await this.api('POST', `/runs/${this.runId}/${a}`); await this.loadRun(); }); },
    confirmAbort() { if (confirm('Прервать весь запуск и убить запущенные процессы?')) this.act('abort'); },
    abortItem(item) { if (confirm(`Исключить ${item} из запуска?`)) this.guard(async () => { await this.api('POST', `/runs/${this.runId}/items/${encodeURIComponent(item)}/abort`); await this.loadRun(); }); },
    ensureFields(key) { return (this.answerFields[key] ??= {}); },
    answer(item, step, answer, fields = {}) { return this.guard(async () => {
      await this.api('POST', `/runs/${this.runId}/answer`, { item: item ?? '_', step, answer, fields });
      delete this.answerFields[`${item ?? '*'}:${step}`];
      await this.loadRun();
    }); },
    cellOf(d) { return d.item ? this.run.cells[d.item][d.step] : this.run.once[d.step]; },
    canRetry(c) { return ['paused', 'interrupted', 'unverified', 'failed', 'skipped'].includes(c.status) && !c.noRetry; },
    open(item, step) { this.drawer = { kind: 'cell', item, step }; this.loadLog('log'); },
    loadLog(kind) { return this.guard(async () => {
      const c = this.cellOf(this.drawer);
      const res = await fetch(`/api/runs/${this.runId}/log?item=${encodeURIComponent(this.drawer.item ?? '_')}&step=${encodeURIComponent(this.drawer.step)}&seq=${c.seq}&kind=${encodeURIComponent(kind)}`, { headers: { 'x-runboard-token': this.token } });
      this.logText = res.ok ? await res.text() : `(нет ${kind} для seq ${c.seq})`;
    }); },
    loadRender() { return this.guard(async () => { const r = await this.api('POST', `/runs/${this.runId}/render`, { item: this.drawer.item ?? '_', step: this.drawer.step }); this.logText = r.command; }); },
    cellAct(a) { return this.guard(async () => { await this.api('POST', `/runs/${this.runId}/cells/${encodeURIComponent(this.drawer.item ?? '_')}/${encodeURIComponent(this.drawer.step)}/${encodeURIComponent(a)}`); await this.loadRun(); }); },
    openCtx(item) { return this.guard(async () => { const d = await this.api('GET', `/runs/${this.runId}/context?item=${encodeURIComponent(item ?? '_')}`); this.ctx = { item, ...d }; }); },
    saveNotes() { return this.guard(async () => { await this.api('PUT', `/runs/${this.runId}/context?item=${encodeURIComponent(this.ctx.item ?? '_')}`, { notes: this.ctx.notes }); }); },
  },
  mounted() { window.addEventListener('hashchange', () => this.route()); this.route(); },
}).mount('#app');

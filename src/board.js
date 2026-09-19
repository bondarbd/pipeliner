import { localDate } from './queue.js';

const NEEDS_HUMAN = new Set(['paused', 'waiting', 'interrupted', 'unverified']);

// One flat list across runs and queues: what needs the human now (default) or everything
// alive (all=true). Rows are plain data for both the CLI table and the UI.
export function boardRows({ runs = [], items = [], all = false, today = localDate() }) {
  const rows = [];
  for (const run of runs) {
    if (run.pilot?.status === 'waiting') {
      rows.push({ kind: 'run', group: run.templateName, item: run.pilot.item, step: 'pilot', state: 'waiting', info: 'пилот прошёл, продолжать на остальных?', age: run.createdAt, runId: run.id, needsMe: true });
    }
    for (const s of run.steps) {
      for (const it of s.once ? [null] : run.items) {
        const c = s.once ? run.once[s.name] : run.cells[it.name]?.[s.name];
        if (!c) continue;
        const needsMe = NEEDS_HUMAN.has(c.status);
        if (!needsMe && !(all && c.status === 'running')) continue;
        rows.push({ kind: 'run', group: run.templateName, item: it ? it.name : '*', step: s.name, state: c.status,
          info: c.waiting?.question || c.error || '', age: c.startedAt || it?.addedAt || run.createdAt,
          link: it?.link || null, runId: run.id, needsMe });
      }
    }
  }
  for (const it of items) {
    if (!['open', 'snoozed'].includes(it.status)) continue;
    const overdue = it.status === 'snoozed' && it.until <= today;
    if (!all && !overdue) continue;
    rows.push({ kind: 'queue', group: it.queue, item: it.id, step: null, state: overdue ? 'overdue' : it.status,
      info: it.text + (it.until ? ` (до ${it.until})` : ''), age: it.createdAt, link: it.link, runId: null, needsMe: overdue });
  }
  rows.sort((a, b) => (Number(b.needsMe) - Number(a.needsMe)) || a.group.localeCompare(b.group) || String(a.age).localeCompare(String(b.age)));
  return rows;
}

export function ageOf(iso, now = Date.now()) {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60_000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d ? `${d}д` : h ? `${h}ч` : `${m}м`;
}

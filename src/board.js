import { localDate, isOpen } from './queue.js';

const NEEDS_HUMAN = new Set(['paused', 'waiting', 'interrupted', 'unverified']);

// One flat list across runs and queues: what needs the human now (default) or everything
// alive (all=true). Rows are plain data for both the CLI table and the UI; `age` is
// already formatted so the two never disagree.
export function boardRows({ runs = [], items = [], all = false, today = localDate(), now = Date.now() }) {
  const rows = [];
  const push = (r) => rows.push({ ...r, age: ageOf(r.since, now) });
  for (const run of runs) {
    if (run.pilot?.status === 'waiting') {
      push({ kind: 'run', group: run.templateName, item: run.pilot.item, step: 'pilot', state: 'waiting', info: 'пилот прошёл, продолжать на остальных?', since: run.createdAt, link: null, runId: run.id, needsMe: true });
    }
    for (const s of run.steps) {
      for (const it of s.once ? [null] : run.items) {
        const c = s.once ? run.once[s.name] : run.cells[it.name]?.[s.name];
        if (!c) continue;
        const needsMe = NEEDS_HUMAN.has(c.status);
        if (!needsMe && !(all && c.status === 'running')) continue;
        // a queue-born item is as old as the debt, not as old as this morning's run
        push({ kind: 'run', group: run.templateName, item: it ? it.name : '*', step: s.name, state: c.status,
          info: c.waiting?.question || c.error || '', since: it?.createdAt || c.startedAt || it?.addedAt || run.createdAt,
          link: it?.link || null, runId: run.id, needsMe });
      }
    }
  }
  for (const it of items) {
    if (!['open', 'snoozed'].includes(it.status)) continue;
    const overdue = it.status === 'snoozed' && isOpen(it, today);
    if (!all && !overdue) continue;
    push({ kind: 'queue', group: it.queue, item: it.id, step: null, state: overdue ? 'overdue' : it.status,
      info: it.text + (it.until ? ` (до ${it.until})` : ''), since: it.createdAt, link: it.link, runId: it.runId || null, needsMe: overdue });
  }
  return rows.sort((a, b) => (Number(b.needsMe) - Number(a.needsMe)) || a.group.localeCompare(b.group) || String(a.since).localeCompare(String(b.since)));
}

export function ageOf(iso, now = Date.now()) {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60_000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d ? `${d}д` : h ? `${h}ч` : `${m}м`;
}

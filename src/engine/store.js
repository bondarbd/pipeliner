import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function runsDir(home) { return path.join(home, 'runs'); }
const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');
export const VALID_ID = /^[A-Za-z0-9._-]+$/;

export function newRunId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(3).toString('base64url').replace(/[^a-z0-9]/gi, 'x').slice(0, 4).toLowerCase()}`;
}

export function newCell() {
  return { status: 'pending', attempts: 0, retriesUsed: 0, rung: 0, diagnosed: false, noRetry: false, seq: null, pid: null,
    output: null, error: null, note: null, command: null, waiting: null, needInput: false, startedAt: null, finishedAt: null, retryAt: null };
}

export function paths(run, itemName) {
  const base = itemName ? path.join(run.dir, 'items', safe(itemName)) : run.dir;
  const ctxDir = path.join(base, 'context');
  const logsDir = path.join(base, 'logs');
  return {
    base, ctxDir, logsDir,
    notes: path.join(ctxDir, 'notes.md'),
    stepsDir: path.join(ctxDir, 'steps'),
    outDir: (step, seq) => path.join(base, 'out', `${safe(step)}.${seq}`),
    logPath: (step, seq) => path.join(logsDir, `${safe(step)}.${seq}.log`),
  };
}

function ensureDirs(run, itemName) {
  const p = paths(run, itemName);
  for (const d of [p.ctxDir, p.logsDir, p.stepsDir, path.join(p.base, 'out')]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
}

export function itemCell(run, itemName, stepName) {
  const bag = itemName ? (run.cells[itemName] ??= {}) : run.once;
  return (bag[stepName] ??= newCell());
}

export function createRun(home, { template, params = {}, items = [], mode = 'all', initiator = { via: 'cli' } }) {
  const id = newRunId();
  const dir = path.join(runsDir(home), id);
  const now = new Date().toISOString();
  const run = {
    id, dir, templateName: template.tpl.name, templateHash: template.hash, templateDir: template.dir,
    steps: structuredClone(template.tpl.steps), params, mode,
    status: 'running', pausedByUser: false, note: null,
    createdAt: now, updatedAt: now, finishedAt: null, initiator,
    items: items.map((it) => ({ status: 'active', ...it })),
    cells: {}, once: {},
    pilot: mode === 'pilot' && items.length ? { item: items[0].name, status: 'running' } : null,
    pilotNotes: null, budgets: { agentCalls: 0 }, seq: 0, history: [],
  };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  ensureDirs(run, null);
  for (const it of run.items) {
    ensureDirs(run, it.name);
    for (const s of run.steps) if (s.each) itemCell(run, it.name, s.name);
  }
  for (const s of run.steps) if (s.once) itemCell(run, null, s.name);
  fs.writeFileSync(path.join(paths(run, null).ctxDir, 'run.md'),
    `# ${run.templateName} — run ${id}\n\nStarted: ${now}\nMode: ${mode}\n\n## Params\n\n\`\`\`json\n${JSON.stringify(params, null, 2)}\n\`\`\`\n\n## Items\n\n${run.items.map((i) => `- ${i.name}`).join('\n')}\n\n## Decisions\n\n`);
  saveRun(run);
  return run;
}

export function saveRun(run) {
  run.updatedAt = new Date().toISOString();
  const file = path.join(run.dir, 'run.json');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(run, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function loadRun(home, id) {
  if (!VALID_ID.test(id)) throw new Error(`invalid run id: ${id}`);
  return JSON.parse(fs.readFileSync(path.join(runsDir(home), id, 'run.json'), 'utf8'));
}

export function listRuns(home) {
  const dir = runsDir(home);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const id of fs.readdirSync(dir).sort().reverse()) {
    try {
      const r = loadRun(home, id);
      out.push({ id: r.id, templateName: r.templateName, status: r.status, mode: r.mode, params: r.params, createdAt: r.createdAt, updatedAt: r.updatedAt, items: r.items.length });
    } catch { /* skip broken dirs */ }
  }
  return out;
}

export function nextSeq(run) { run.seq = (run.seq || 0) + 1; return run.seq; }

export function addEvent(run, ev) { run.history.push({ t: new Date().toISOString(), ...ev }); }

export function saveStepOutput(run, itemName, step, output) {
  ensureDirs(run, itemName);
  fs.writeFileSync(path.join(paths(run, itemName).stepsDir, `${safe(step)}.json`), JSON.stringify(output ?? {}, null, 2));
}

export function appendNotes(run, itemName, text, who = 'human') {
  ensureDirs(run, itemName);
  fs.appendFileSync(paths(run, itemName).notes, `\n### ${new Date().toISOString()} [${who}] ${text}\n`);
}

export function readNotes(run, itemName, maxBytes = 8192) {
  const f = paths(run, itemName).notes;
  if (!fs.existsSync(f)) return '';
  const s = fs.readFileSync(f, 'utf8');
  return s.length > maxBytes ? s.slice(-maxBytes) : s;
}

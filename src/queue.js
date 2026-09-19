import fs from 'node:fs';
import path from 'node:path';
import { newRunId, VALID_ID } from './engine/store.js';

// Queues are plain JSON files next to the engine: <home>/inbox/<queue>/<id>.json.
// The engine never reads them by itself; a run with `items: { source: queue }` takes the
// open ones at creation time (marking them with its runId), and a js step closes them
// through ctx.queue.

export const QUEUE_RE = /^[a-z][a-z0-9-]*$/;
export const MAX_SNOOZES = 3;
const KEEP_CLOSED_DAYS = 30;
const BAD_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:']);

const pad = (n) => String(n).padStart(2, '0');
export const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// the link is rendered as an href on the board: it must parse as a URL and not run code
export function checkLink(link) {
  if (!link) return null;
  let u;
  try { u = new URL(String(link).trim()); } catch { throw new Error('link must be a URL (https://… or an app scheme)'); }
  if (BAD_SCHEMES.has(u.protocol)) throw new Error(`link scheme ${u.protocol} is not allowed`);
  return u.href;
}

function dir(home, q) {
  if (!QUEUE_RE.test(String(q))) throw new Error(`invalid queue name: ${q}`);
  return path.join(home, 'inbox', q);
}
function file(home, q, id) {
  if (!VALID_ID.test(String(id))) throw new Error(`invalid item id: ${id}`);
  return path.join(dir(home, q), `${id}.json`);
}
function write(home, q, it) {
  const f = file(home, q, it.id);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(it, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, f);
  return it;
}
function read(home, q, id) {
  const f = file(home, q, id);
  if (!fs.existsSync(f)) throw new Error(`no item ${q}/${id}`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
const closed = (it, status, note = it.note) => ({ ...it, status, until: null, runId: null, closedAt: new Date().toISOString(), note });

export function add(home, q, { text, link } = {}) {
  text = String(text ?? '').trim();
  if (!text) throw new Error('empty text');
  link = checkLink(link);
  let id = newRunId();
  while (fs.existsSync(file(home, q, id))) id = newRunId();   // same second, same random suffix: try again
  return write(home, q, { id, text, link, createdAt: new Date().toISOString(), status: 'open', until: null, snoozes: 0, runId: null, closedAt: null, note: null });
}

export function queues(home) {
  const root = path.join(home, 'inbox');
  return fs.existsSync(root) ? fs.readdirSync(root).filter((n) => QUEUE_RE.test(n)).sort() : [];
}

// every item of the queue(s), except those closed more than 30 days ago
export function list(home, q) {
  const cutoff = Date.now() - KEEP_CLOSED_DAYS * 86400_000;
  const out = [];
  for (const name of q ? [q] : queues(home)) {
    const d = dir(home, name);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).filter((n) => n.endsWith('.json')).sort()) {
      try {
        const it = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
        if (it.closedAt && Date.parse(it.closedAt) < cutoff) continue;
        out.push({ queue: name, ...it });
      } catch { /* half-written or foreign file */ }
    }
  }
  return out.sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) || String(a.id).localeCompare(String(b.id)));
}

export const isOpen = (it, day = localDate()) => it.status === 'open' || (it.status === 'snoozed' && it.until <= day);
export function open(home, q) { return list(home, q).filter((it) => isOpen(it)); }

// a run took the item: it stays open in the queue but is not handed to another run while that one lives
export function take(home, q, id, runId) { return write(home, q, { ...read(home, q, id), runId }); }
export function done(home, q, id) { return write(home, q, closed(read(home, q, id), 'done')); }
export function drop(home, q, id, note = null) { return write(home, q, closed(read(home, q, id), 'dropped', note)); }

export function snoozeDate(when, from = new Date()) {
  const w = String(when).trim().toLowerCase();
  const d = new Date(from); d.setHours(12, 0, 0, 0);
  const m = w.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const x = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
    if (localDate(x) !== w) throw new Error(`snooze: no such date ${when}`);
    return w;
  }
  if (['tomorrow', 'завтра'].includes(w)) d.setDate(d.getDate() + 1);
  else if (['monday', 'понедельник'].includes(w)) d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  else if (['week', 'неделя'].includes(w)) d.setDate(d.getDate() + 7);
  else throw new Error(`snooze: expected tomorrow|monday|week|YYYY-MM-DD, got "${when}"`);
  return localDate(d);
}

// the third snooze closes the item instead: a list full of zombies is worse than a lost debt
export function snooze(home, q, id, when) {
  const it = read(home, q, id);
  const snoozes = it.snoozes + 1;
  if (snoozes >= MAX_SNOOZES) return write(home, q, { ...closed(it, 'dropped', `auto-closed after ${MAX_SNOOZES} snoozes`), snoozes });
  return write(home, q, { ...it, snoozes, status: 'snoozed', runId: null, until: snoozeDate(when) });
}

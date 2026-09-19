import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as store from './engine/store.js';
import { NeedsTrust } from './engine/manager.js';
import { render } from './expr.js';
import { previewRows } from './preview.js';
import { createMasker, secretValues } from './secrets.js';
import * as queue from './queue.js';
import { boardRows } from './board.js';

const MIN_BYTES = 1;
const MAX_BYTES = 1_000_000;
const DEFAULT_BYTES = 65536;

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

function tokensEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function createApp(opts) {
  const { manager, token, publicDir } = opts;
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
    next();
  });
  app.use((req, res, next) => {
    const host = req.headers.host || '';
    if (host !== `127.0.0.1:${opts.port}`) return res.status(403).send('forbidden host');
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${opts.port}`) return res.status(403).send('forbidden origin');
    next();
  });
  // Token check first (cheap, timing-safe, no body parsing yet), then JSON parsing.
  app.use('/api', (req, res, next) => {
    if (!tokensEqual(req.headers['x-runboard-token'], token)) return res.status(401).json({ error: 'missing or invalid token' });
    next();
  });
  app.use('/api', express.json({ limit: '2mb' }));
  if (publicDir) app.use(express.static(publicDir));

  const run = (req, res) => { const r = manager.get(req.params.id); if (!r) res.status(404).json({ error: 'run not found' }); return r; };
  const eng = (req, res) => { const e = manager.engine(req.params.id); if (!e) res.status(409).json({ error: 'run is not live (finished or not loaded)' }); return e; };
  const act = (fn) => async (req, res) => { try { await fn(req, res); if (!res.headersSent) res.status(204).end(); } catch (e) { if (!res.headersSent) res.status(400).json({ error: e.message }); } };
  const itemName = (s) => (s === '_' || s === '*' || s === '' || s == null ? null : s);   // once-step cells have no item

  app.get('/api/templates', (req, res) => {
    manager.reloadTemplates();
    const templates = [...manager.templates.values()].map(({ tpl, hash }) => ({ name: tpl.name, title: tpl.title, description: tpl.description, params: tpl.params || {}, items: tpl.items || {}, modes: tpl.modes || ['all'], hash, trusted: manager.trusted(tpl.name, hash) }));
    res.json({ templates, errors: manager.templateErrors });
  });
  app.post('/api/templates/:name/trust', act((req) => manager.trust(req.params.name, req.body.hash)));
  app.post('/api/templates/:name/preview', (req, res) => {
    const t = manager.templates.get(req.params.name);
    if (!t) return res.status(404).json({ error: 'template not found' });
    const { params = {}, items = [] } = req.body || {};
    try {
      const rows = previewRows(manager, t, { params, items }, createMasker(secretValues(manager.envValues)));
      res.json({ rows });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.get('/api/projects', (req, res) => res.json(manager.listProjects()));

  app.get('/api/board', (req, res) => {
    const runs = manager.list().filter((s) => !['done', 'aborted'].includes(s.status)).map((s) => manager.get(s.id)).filter(Boolean);
    res.json(boardRows({ runs, items: queue.list(manager.home), all: req.query.all === '1' }));
  });
  app.get('/api/queues', (req, res) => res.json(queue.list(manager.home).filter((it) => req.query.all === '1' || ['open', 'snoozed'].includes(it.status))));
  app.post('/api/queues/:name', (req, res) => {
    try { res.status(201).json(queue.add(manager.home, req.params.name, { text: req.body.text, link: req.body.link })); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/queues/:name/:id/done', act((req) => queue.done(manager.home, req.params.name, req.params.id)));
  app.post('/api/queues/:name/:id/drop', act((req) => queue.drop(manager.home, req.params.name, req.params.id, 'dropped by user')));
  app.post('/api/queues/:name/:id/snooze', act((req) => queue.snooze(manager.home, req.params.name, req.params.id, req.body.when || 'tomorrow')));

  app.get('/api/runs', (req, res) => res.json(manager.list()));
  app.post('/api/runs', async (req, res) => {
    try {
      const { template, params = {}, items = [], mode = 'all' } = req.body || {};
      const r = await manager.create({ templateName: template, params, items, mode, initiator: { via: 'ui', user: process.env.USER } });
      res.status(201).json({ id: r.id });
    } catch (e) {
      if (e instanceof NeedsTrust) return res.status(409).json({ needsTrust: true, template: e.templateName, hash: e.hash, commands: e.commands });
      res.status(400).json({ error: e.message });
    }
  });
  app.get('/api/runs/:id', (req, res) => { const r = run(req, res); if (r) res.json(r); });
  app.get('/api/runs/:id/log', (req, res) => {
    const r = run(req, res); if (!r) return;
    const { item, step, seq, kind = 'log' } = req.query;
    if (!/^\d+$/.test(String(seq))) return res.status(400).json({ error: 'invalid seq' });
    if (!store.LOG_KINDS.includes(kind)) return res.status(400).json({ error: 'invalid kind' });
    let bytes = Number.parseInt(req.query.bytes, 10);
    if (!Number.isFinite(bytes) || bytes < MIN_BYTES) bytes = DEFAULT_BYTES;
    const file = store.logFile(r, itemName(item || '_'), step, seq, kind);
    const logsDir = `${path.resolve(store.paths(r, itemName(item || '_')).logsDir)}${path.sep}`;
    if (!path.resolve(file).startsWith(logsDir)) return res.status(400).json({ error: 'invalid path' });
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'no log' });
    res.type('text/plain').send(store.tailFile(file, Math.min(bytes, MAX_BYTES)));
  });
  app.get('/api/runs/:id/context', (req, res) => {
    const r = run(req, res); if (!r) return;
    const it = itemName(req.query.item || '_');
    const p = store.paths(r, it);
    const steps = {};
    if (fs.existsSync(p.stepsDir)) for (const f of fs.readdirSync(p.stepsDir)) steps[f.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(p.stepsDir, f), 'utf8'));
    const notes = fs.existsSync(p.notes) ? fs.readFileSync(p.notes, 'utf8') : '';
    res.json({ notes, notesHash: hash(notes), steps });
  });
  // the editor sends back the hash it loaded; if an agent appended to notes.md meanwhile, refuse rather than lose its lines
  app.put('/api/runs/:id/context', (req, res) => {
    const r = run(req, res); if (!r) return;
    const p = store.paths(r, itemName(req.query.item || '_'));
    const current = fs.existsSync(p.notes) ? fs.readFileSync(p.notes, 'utf8') : '';
    if (req.body.notesHash !== undefined && req.body.notesHash !== hash(current)) return res.status(409).json({ error: 'notes.md changed since you opened it — reload and re-apply your edit' });
    fs.mkdirSync(p.ctxDir, { recursive: true });
    fs.writeFileSync(p.notes, String(req.body.notes ?? ''));
    res.status(204).end();
  });
  app.post('/api/clean', (req, res) => res.json({ removed: manager.clean(req.body?.days ? Number(req.body.days) : undefined) }));
  app.post('/api/runs/:id/render', (req, res) => {
    const r = run(req, res); if (!r) return;
    const { item, step } = req.body || {};
    const s = r.steps.find((x) => x.name === step); if (!s) return res.status(404).json({ error: 'step not found' });
    const it = item && item !== '_' ? r.items.find((x) => x.name === item) : null;
    const e = manager.engine(r.id);
    try {
      const ctx = e ? e.exprCtx(it, s) : null;
      if (!ctx) return res.status(409).json({ error: 'run is not live' });
      const body = s.shell ?? s.check ?? s.verify ?? s.agent?.prompt ?? s.human?.question ?? s.js;
      const rendered = render(body, ctx, { shell: !!s.shell && !s.raw });
      res.json({ command: e.masker.mask(String(rendered)) });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });
  app.post('/api/runs/:id/cells/:item/:step/retry', act((req, res) => { const e = eng(req, res); if (e) e.retry(itemName(req.params.item), req.params.step); }));
  app.post('/api/runs/:id/cells/:item/:step/skip', act((req, res) => { const e = eng(req, res); if (e) e.skipCell(itemName(req.params.item), req.params.step); }));
  app.post('/api/runs/:id/items/:item/abort', act(async (req, res) => { const e = eng(req, res); if (e) await e.abortItem(req.params.item); }));
  app.post('/api/runs/:id/answer', act((req, res) => { const e = eng(req, res); if (e) e.answer(req.body.item === '__pilot__' ? '__pilot__' : itemName(req.body.item), req.body.step, { answer: req.body.answer, fields: req.body.fields || {} }); }));
  app.post('/api/runs/:id/pause', act((req, res) => { const e = eng(req, res); if (e) e.pauseRun(); }));
  app.post('/api/runs/:id/resume', act((req, res) => { const e = eng(req, res); if (e) e.resumeRun(); }));
  app.post('/api/runs/:id/abort', act(async (req, res) => { const e = eng(req, res); if (e) await e.abort('aborted by user'); }));

  // Terminal error handler: never leak a stack trace (or express's default HTML
  // error page, which can echo file paths from node_modules) to the client.
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    res.status(err.status || err.statusCode || 500).json({ error: err.message });
  });
  return app;
}

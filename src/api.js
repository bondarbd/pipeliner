import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import * as store from './engine/store.js';
import { NeedsTrust } from './engine/manager.js';
import { render } from './expr.js';

export function createApp(opts) {
  const { manager, token, publicDir } = opts;
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.headers.host || '';
    if (host !== `127.0.0.1:${opts.port}`) return res.status(403).send('forbidden host');
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${opts.port}`) return res.status(403).send('forbidden origin');
    next();
  });
  app.use('/api', express.json({ limit: '2mb' }), (req, res, next) => {
    if (req.headers['x-runboard-token'] !== token) return res.status(401).json({ error: 'missing or invalid token' });
    next();
  });
  if (publicDir) app.use(express.static(publicDir));

  const run = (req, res) => { const r = manager.get(req.params.id); if (!r) res.status(404).json({ error: 'run not found' }); return r; };
  const eng = (req, res) => { const e = manager.engine(req.params.id); if (!e) res.status(409).json({ error: 'run is not live (finished or not loaded)' }); return e; };
  const act = (fn) => async (req, res) => { try { await fn(req, res); if (!res.headersSent) res.status(204).end(); } catch (e) { if (!res.headersSent) res.status(400).json({ error: e.message }); } };
  const itemName = (s) => (s === '_' ? null : s);

  app.get('/api/templates', (req, res) => {
    manager.reloadTemplates();
    const templates = [...manager.templates.values()].map(({ tpl, hash }) => ({ name: tpl.name, title: tpl.title, description: tpl.description, params: tpl.params || {}, items: tpl.items || {}, modes: tpl.modes || ['all'], hash, trusted: manager.trusted(tpl.name, hash) }));
    res.json({ templates, errors: manager.templateErrors });
  });
  app.post('/api/templates/:name/trust', act((req) => manager.trust(req.params.name, req.body.hash)));
  app.get('/api/projects', (req, res) => {
    const root = manager.config.projects_root;
    if (!fs.existsSync(root)) return res.json([]);
    res.json(fs.readdirSync(root).filter((n) => fs.existsSync(path.join(root, n, '.git')) || fs.existsSync(path.join(root, n, 'pom.xml'))).sort());
  });

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
    const { item, step, seq, kind = 'log', bytes = 65536 } = req.query;
    const p = store.paths(r, itemName(item || '_'));
    const ext = kind === 'log' ? 'log' : kind === 'diff' ? 'diff' : `${kind}.log`;
    const file = p.logPath(step, seq).replace(/\.log$/, `.${ext}`);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'no log' });
    const size = fs.statSync(file).size; const start = Math.max(0, size - Number(bytes));
    const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(size - start); fs.readSync(fd, buf, 0, buf.length, start); fs.closeSync(fd);
    res.type('text/plain').send((start ? `[…${start} bytes skipped]\n` : '') + buf.toString('utf8'));
  });
  app.get('/api/runs/:id/context', (req, res) => {
    const r = run(req, res); if (!r) return;
    const it = itemName(req.query.item || '_');
    const p = store.paths(r, it);
    const steps = {};
    if (fs.existsSync(p.stepsDir)) for (const f of fs.readdirSync(p.stepsDir)) steps[f.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(p.stepsDir, f), 'utf8'));
    res.json({ notes: fs.existsSync(p.notes) ? fs.readFileSync(p.notes, 'utf8') : '', steps });
  });
  app.put('/api/runs/:id/context', act((req, res) => { const r = run(req, res); if (!r) return; const p = store.paths(r, itemName(req.query.item || '_')); fs.mkdirSync(p.ctxDir, { recursive: true }); fs.writeFileSync(p.notes, String(req.body.notes ?? '')); }));
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
      res.json({ command: render(body, ctx, { shell: !!s.shell && !s.raw }) });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });
  app.post('/api/runs/:id/cells/:item/:step/retry', act((req, res) => { const e = eng(req, res); if (e) e.retry(itemName(req.params.item), req.params.step); }));
  app.post('/api/runs/:id/cells/:item/:step/skip', act((req, res) => { const e = eng(req, res); if (e) e.skipCell(itemName(req.params.item), req.params.step); }));
  app.post('/api/runs/:id/items/:item/abort', act(async (req, res) => { const e = eng(req, res); if (e) await e.abortItem(req.params.item); }));
  app.post('/api/runs/:id/answer', act((req, res) => { const e = eng(req, res); if (e) e.answer(req.body.item === '_' ? null : req.body.item, req.body.step, { answer: req.body.answer, fields: req.body.fields || {} }); }));
  app.post('/api/runs/:id/pause', act((req, res) => { const e = eng(req, res); if (e) e.pauseRun(); }));
  app.post('/api/runs/:id/resume', act((req, res) => { const e = eng(req, res); if (e) e.resumeRun(); }));
  app.post('/api/runs/:id/abort', act(async (req, res) => { const e = eng(req, res); if (e) await e.abort('aborted by user'); }));
  return app;
}

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { loadConfig } from '../src/config.js';
import { Manager } from '../src/engine/manager.js';
import { startServer } from '../src/server.js';
import { paths } from '../src/engine/store.js';
import { fakeRunner } from '../src/runners/fake.js';
import * as human from '../src/runners/human.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-api-'));
const tdir = path.join(home, 'templates'); fs.mkdirSync(tdir);
const proj = path.join(home, 'projects'); fs.mkdirSync(path.join(proj, 'p1', '.git'), { recursive: true }); fs.mkdirSync(path.join(proj, 'junk'));
fs.writeFileSync(path.join(tdir, 'demo.yaml'), 'name: demo\nitems: { source: dirs }\nsteps:\n  - { name: s, each: true, shell: "echo hi" }\n  - { name: ask, each: true, human: { question: "ok?" } }\n');
const cfg = loadConfig(home); cfg.projects_root = proj;
const fake = fakeRunner({ 'p1:s': { ok: false, error: 'boom' } });
const manager = new Manager({ home, config: cfg, runners: { shell: fake, js: fake, agent: fake, human }, envValues: {}, templateDirs: [tdir] });
let srv;
after(() => srv?.server.close());

const api = (p, opts = {}) => fetch(`${srv.url}/api${p}`, { ...opts, headers: { 'content-type': 'application/json', 'x-runboard-token': srv.token, ...(opts.headers || {}) } });

test('security: token, host and origin checks', async () => {
  await manager.init();
  srv = await startServer({ home, config: cfg, manager, port: 0 });
  assert.equal((await fetch(`${srv.url}/api/templates`)).status, 401);
  const rawStatus = (headers) => new Promise((res) => { const req = http.request({ host: '127.0.0.1', port: srv.port, path: '/api/templates', headers: { 'x-runboard-token': srv.token, ...headers } }, (r) => { r.resume(); res(r.statusCode); }); req.end(); });
  assert.equal(await rawStatus({ host: 'evil:1' }), 403);
  assert.equal(await rawStatus({ host: `127.0.0.1:${srv.port}` }), 200);
  assert.equal((await api('/templates', { headers: { origin: 'http://evil' } })).status, 403);
  assert.equal((await api('/templates', { headers: { origin: `http://127.0.0.1:${srv.port}` } })).status, 200);
  assert.equal(fs.statSync(path.join(home, 'token')).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'server.json'), 'utf8')).port, srv.port);
});

test('templates, projects, trust flow, run lifecycle over HTTP', async () => {
  const tpls = await (await api('/templates')).json();
  assert.equal(tpls.templates[0].name, 'demo'); assert.equal(tpls.templates[0].trusted, false);
  assert.deepEqual(await (await api('/projects')).json(), ['p1']);
  let r = await api('/runs', { method: 'POST', body: JSON.stringify({ template: 'demo', items: ['p1'] }) });
  assert.equal(r.status, 409); const c = await r.json(); assert.ok(c.needsTrust); assert.ok(c.commands.length);
  assert.equal((await api('/templates/demo/trust', { method: 'POST', body: JSON.stringify({ hash: c.hash }) })).status, 204);
  r = await api('/runs', { method: 'POST', body: JSON.stringify({ template: 'demo', items: ['p1'] }) });
  assert.equal(r.status, 201); const { id } = await r.json();
  await manager.engine(id).idle();
  let run = await (await api(`/runs/${id}`)).json();
  assert.equal(run.cells.p1.s.status, 'paused');
  assert.equal((await api(`/runs/${id}/cells/p1/s/skip`, { method: 'POST' })).status, 204);
  await manager.engine(id).idle();
  run = await (await api(`/runs/${id}`)).json();
  assert.equal(run.cells.p1.ask.status, 'waiting');
  assert.equal((await api(`/runs/${id}/answer`, { method: 'POST', body: JSON.stringify({ item: 'p1', step: 'ask', answer: 'Да' }) })).status, 204);
  await manager.engine(id).idle();
  assert.equal((await (await api(`/runs/${id}`)).json()).status, 'done');
  const ctx = await (await api(`/runs/${id}/context?item=p1`)).json();
  assert.match(ctx.notes, /A: Да/);
  assert.equal((await api(`/runs/${id}/context?item=p1`, { method: 'PUT', body: JSON.stringify({ notes: 'edited' }) })).status, 204);
  assert.equal((await (await api(`/runs/${id}/context?item=p1`)).json()).notes, 'edited');
  const rend = await (await api(`/runs/${id}/render`, { method: 'POST', body: JSON.stringify({ item: 'p1', step: 's' }) })).json();
  assert.equal(rend.command, 'echo hi');
  assert.equal((await api(`/runs/${id}/log?item=p1&step=s&seq=1`)).status, 404);   // fake runner writes no log
  fs.writeFileSync(paths(manager.get(id), 'p1').logPath('s', 1), 'line1\nline2\n');
  assert.equal(await (await api(`/runs/${id}/log?item=p1&step=s&seq=1`)).text(), 'line1\nline2\n');
  // Engine.retry now refuses once the run has reached a terminal status ('done'/'aborted')
  // — retry/skipCell/answer all throw `run is <status>` for TERMINAL_RUN, so the route
  // reports it as a 400, not a success.
  const retryAfterDone = await api(`/runs/${id}/cells/p1/s/retry`, { method: 'POST' });
  assert.equal(retryAfterDone.status, 400);
  assert.match((await retryAfterDone.json()).error, /run is done/);
  assert.equal((await api('/runs/nope')).status, 404);
  assert.equal((await (await api('/runs')).json())[0].id, id);
});

test('log route rejects path traversal in seq, kind and run id', async () => {
  let r = await api('/runs', { method: 'POST', body: JSON.stringify({ template: 'demo', items: ['p1'] }) });
  const { id } = await r.json();
  await manager.engine(id).idle();
  assert.equal((await api(`/runs/${id}/log?item=p1&step=s&seq=..%2Fx`)).status, 400);
  assert.equal((await api(`/runs/${id}/log?item=p1&step=s&seq=1&kind=..%2F..%2Fetc`)).status, 400);
  assert.equal((await api('/runs/..%2Fx')).status, 404);
});

test('security headers: X-Frame-Options and CSP are set on every response, including the UI page', async () => {
  const res = await fetch(`${srv.url}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('content-security-policy'), "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
});

test('log bytes is clamped to a safe range; malformed JSON body yields a clean 400', async () => {
  let r = await api('/runs', { method: 'POST', body: JSON.stringify({ template: 'demo', items: ['p1'] }) });
  const { id } = await r.json();
  await manager.engine(id).idle();
  fs.writeFileSync(paths(manager.get(id), 'p1').logPath('s', 1), 'line1\nline2\n');
  let lr = await api(`/runs/${id}/log?item=p1&step=s&seq=1&bytes=abc`);
  assert.equal(lr.status, 200);
  assert.equal(await lr.text(), 'line1\nline2\n');
  lr = await api(`/runs/${id}/log?item=p1&step=s&seq=1&bytes=-1`);
  assert.equal(lr.status, 200);
  assert.equal(await lr.text(), 'line1\nline2\n');

  const bad = await fetch(`${srv.url}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-runboard-token': srv.token }, body: '{not json' });
  assert.equal(bad.status, 400);
  const body = await bad.json();
  assert.ok(body.error);
  assert.ok(!body.error.includes('node_modules'));
});

test('template preview returns a rendered (engine-free) row per item x step', async () => {
  const r = await api('/templates/demo/preview', { method: 'POST', body: JSON.stringify({ params: {}, items: ['p1'] }) });
  assert.equal(r.status, 200);
  const { rows } = await r.json();
  assert.ok(rows.some((row) => row.item === 'p1' && row.step === 's' && row.command === 'echo hi'));
  assert.ok(rows.some((row) => row.item === 'p1' && row.step === 'ask'));
});

test('render masks secret env values', async () => {
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-api-mask-'));
  const tdir2 = path.join(home2, 'templates'); fs.mkdirSync(tdir2);
  fs.writeFileSync(path.join(tdir2, 'secret.yaml'), 'name: secret\nitems: { source: manual, default: [{ name: p1 }] }\nsteps:\n  - { name: s, each: true, env: [SECRET], shell: "echo ${{ run.env.SECRET }}" }\n');
  const cfg2 = loadConfig(home2);
  const fake2 = fakeRunner({});
  const manager2 = new Manager({ home: home2, config: cfg2, runners: { shell: fake2, js: fake2, agent: fake2, human }, envValues: { SECRET: 'sekrit-value-123' }, templateDirs: [tdir2] });
  await manager2.init();
  const srv2 = await startServer({ home: home2, config: cfg2, manager: manager2, port: 0 });
  try {
    const api2 = (p, opts = {}) => fetch(`${srv2.url}/api${p}`, { ...opts, headers: { 'content-type': 'application/json', 'x-runboard-token': srv2.token, ...(opts.headers || {}) } });
    const tpls = await (await api2('/templates')).json();
    const hash = tpls.templates[0].hash;
    await api2('/templates/secret/trust', { method: 'POST', body: JSON.stringify({ hash }) });
    const r = await api2('/runs', { method: 'POST', body: JSON.stringify({ template: 'secret', items: ['p1'] }) });
    const { id } = await r.json();
    await manager2.engine(id).idle();
    const rend = await (await api2(`/runs/${id}/render`, { method: 'POST', body: JSON.stringify({ item: 'p1', step: 's' }) })).json();
    assert.match(rend.command, /\*\*\*/);
    assert.ok(!rend.command.includes('sekrit-value-123'));
  } finally {
    srv2.server.close();
  }
});

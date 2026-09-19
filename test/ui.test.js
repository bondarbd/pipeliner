import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { Manager } from '../src/engine/manager.js';
import { startServer } from '../src/server.js';

test('index.html and app.js are served, vendor assets exist', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-ui-'));
  const cfg = loadConfig(home);
  const m = new Manager({ home, config: cfg, runners: {}, envValues: {}, templateDirs: [] });
  await m.init();
  const s = await startServer({ home, config: cfg, manager: m, port: 0 });
  after(() => s.server.close());
  const html = await (await fetch(`${s.url}/`)).text();
  assert.match(html, /<title>runboard<\/title>/);
  assert.match(html, /vendor\/vue.global.prod.js/);
  assert.match(html, /vendor\/pico.min.css/);
  const js = await (await fetch(`${s.url}/app.js`)).text();
  assert.match(js, /createApp/);
  assert.ok(fs.existsSync('public/vendor/vue.global.prod.js'), 'run npm install to vendor assets');
});

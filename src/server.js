import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from './api.js';

export function readToken(home) {
  const f = path.join(home, 'token');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const t = crypto.randomBytes(24).toString('base64url');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, t, { mode: 0o600 });
  return t;
}

export function startServer({ home, config, manager, port = config.server?.port ?? 3000, publicDir = path.resolve(new URL('../public', import.meta.url).pathname) }) {
  const token = readToken(home);
  return new Promise((resolve, reject) => {
    let actual = port;
    const app = createApp({ manager, token, get port() { return actual; }, publicDir });
    // express keeps the object reference; the getter lets port 0 resolve after listen
    const server = app.listen(port, '127.0.0.1', () => {
      actual = server.address().port;
      fs.writeFileSync(path.join(home, 'server.json'), JSON.stringify({ port: actual, pid: process.pid }), { mode: 0o600 });
      const url = `http://127.0.0.1:${actual}`;
      server.on('close', () => { try { fs.unlinkSync(path.join(home, 'server.json')); } catch { /* gone */ } });
      resolve({ server, port: actual, token, url });
    });
    server.on('error', reject);
  });
}

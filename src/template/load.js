import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import YAML from 'yaml';
import { validateTemplate } from './validate.js';

export function templateHash(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

const SKIP_DIRS = new Set(['node_modules', '.git']);
const MAX_SIDECAR_FILES = 200;
const MAX_SIDECAR_BYTES = 5 * 1024 * 1024;

function walkFiles(dir, out = [], state = { truncated: false }) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= MAX_SIDECAR_FILES) { state.truncated = true; return out; }
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkFiles(path.join(dir, entry.name), out, state);
      if (state.truncated) return out;
    } else if (entry.isFile()) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// Sidecar files (each step's `js:` script, plus everything under `<dir>/<tpl.name>/`)
// are folded into the template hash, so editing a script invalidates trust the
// same way editing the yaml would. The walk is bounded (file count and total bytes)
// so a stray node_modules/.git under a template dir can't blow up hashing.
function collectSidecars(dir, tpl) {
  const set = new Set();
  const state = { truncated: false };
  for (const s of tpl?.steps || []) {
    if (s && typeof s.js === 'string') {
      const abs = path.resolve(dir, s.js);
      if (fs.existsSync(abs)) set.add(path.relative(dir, abs));
    }
  }
  if (tpl?.name) {
    const sideDir = path.join(dir, tpl.name);
    if (fs.existsSync(sideDir) && fs.statSync(sideDir).isDirectory()) {
      for (const f of walkFiles(sideDir, [], state)) set.add(path.relative(dir, f));
    }
  }
  return { sidecars: [...set].sort(), truncated: state.truncated };
}

export function readTemplate(file) {
  const text = fs.readFileSync(file, 'utf8');
  const tpl = YAML.parse(text);
  const dir = path.dirname(file);
  const { sidecars, truncated: dirTruncated } = collectSidecars(dir, tpl);
  const h = crypto.createHash('sha256').update(text);
  let bytes = 0;
  let sidecarsTruncated = dirTruncated;
  for (const rel of sidecars) {
    let content;
    try { content = fs.readFileSync(path.join(dir, rel)); } catch { continue; } // missing js files ignored (validated elsewhere)
    if (bytes >= MAX_SIDECAR_BYTES) { sidecarsTruncated = true; break; }
    bytes += content.length;
    h.update('\0').update(rel).update('\0').update(content);
  }
  const record = { tpl, hash: h.digest('hex'), file, dir, sidecars };
  if (sidecarsTruncated) record.sidecarsTruncated = true;
  return record;
}

export function loadTemplates(dirs) {
  const templates = new Map();
  const errors = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.yaml') || n.endsWith('.yml')).sort()) {
      const file = path.join(dir, f);
      try {
        const t = readTemplate(file);
        const errs = validateTemplate(t.tpl);
        if (errs.length) { errors.push({ file, errors: errs }); continue; }
        templates.set(t.tpl.name, t);
      } catch (e) {
        errors.push({ file, errors: [{ path: '', message: e.message }] });
      }
    }
  }
  return { templates, errors };
}

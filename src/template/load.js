import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import YAML from 'yaml';
import { validateTemplate } from './validate.js';

export function templateHash(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

// Sidecar files (each step's `js:` script, plus everything under `<dir>/<tpl.name>/`)
// are folded into the template hash, so editing a script invalidates trust the
// same way editing the yaml would.
function collectSidecars(dir, tpl) {
  const set = new Set();
  for (const s of tpl?.steps || []) {
    if (s && typeof s.js === 'string') {
      const abs = path.resolve(dir, s.js);
      if (fs.existsSync(abs)) set.add(path.relative(dir, abs));
    }
  }
  if (tpl?.name) {
    const sideDir = path.join(dir, tpl.name);
    if (fs.existsSync(sideDir) && fs.statSync(sideDir).isDirectory()) {
      for (const f of walkFiles(sideDir)) set.add(path.relative(dir, f));
    }
  }
  return [...set].sort();
}

export function readTemplate(file) {
  const text = fs.readFileSync(file, 'utf8');
  const tpl = YAML.parse(text);
  const dir = path.dirname(file);
  const sidecars = collectSidecars(dir, tpl);
  const h = crypto.createHash('sha256').update(text);
  for (const rel of sidecars) {
    let content;
    try { content = fs.readFileSync(path.join(dir, rel)); } catch { continue; } // missing js files ignored (validated elsewhere)
    h.update('\0').update(rel).update('\0').update(content);
  }
  return { tpl, hash: h.digest('hex'), file, dir, sidecars };
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

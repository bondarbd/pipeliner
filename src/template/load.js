import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import YAML from 'yaml';
import { validateTemplate } from './validate.js';

export function templateHash(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

export function readTemplate(file) {
  const text = fs.readFileSync(file, 'utf8');
  const tpl = YAML.parse(text);
  return { tpl, hash: templateHash(text), file, dir: path.dirname(file) };
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

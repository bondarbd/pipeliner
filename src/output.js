import fs from 'node:fs';
import path from 'node:path';

export class OutputError extends Error {}
const KEY_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

// strips the markdown decoration weaker models add around a line: "**key=value**", "- `key=value`"
function undecorate(raw) {
  let line = raw.trim();
  const lead = line.match(/^(?:[-*>]\s+|\*\*|`)+/)?.[0] || '';
  line = line.slice(lead.length);
  if (lead.includes('**') && line.endsWith('**')) line = line.slice(0, -2);
  if (lead.includes('`') && line.endsWith('`')) line = line.slice(0, -1);
  return line;
}

function keysFrom(text, into) {
  for (const line of text.split('\n')) {
    const m = undecorate(line).match(KEY_RE);
    if (m) into[m[1]] = m[2].trim();
  }
  return into;
}

export function parseOutput(kind = 'keys', { tail = '', outDir }) {
  if (kind === 'text') return { text: tail.trim() };
  if (kind === 'json') {
    const f = path.join(outDir, 'result.json');
    if (fs.existsSync(f)) {
      try {
        return JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch (e) {
        throw new OutputError(`invalid JSON in $OUT/result.json: ${e.message}`);
      }
    }
    for (const line of tail.trim().split('\n').reverse()) {
      const t = line.trim();
      if (t.startsWith('{') || t.startsWith('[')) { try { return JSON.parse(t); } catch { /* keep looking */ } }
    }
    throw new OutputError('no JSON result: expected $OUT/result.json or a JSON line in stdout');
  }
  const out = keysFrom(tail, {});
  const f = path.join(outDir, 'result');
  if (fs.existsSync(f)) keysFrom(fs.readFileSync(f, 'utf8'), out);
  return out;
}

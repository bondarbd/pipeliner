const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createMasker(values = []) {
  const forms = new Set();
  for (const v of values) {
    if (typeof v !== 'string' || v.length < 6) continue;
    forms.add(v);
    forms.add(Buffer.from(v).toString('base64'));
    const enc = encodeURIComponent(v);
    if (enc !== v) forms.add(enc);
  }
  const exact = [...forms].sort((a, b) => b.length - a.length).map(escapeRe);
  const exactRe = exact.length ? new RegExp(exact.join('|'), 'g') : null;
  return {
    mask(s) {
      let out = String(s);
      if (exactRe) out = out.replace(exactRe, '***');
      out = out.replace(/(Authorization:\s*)((?:Basic|Bearer|Token)\s+)?[^\r\n]+/gi, (_, p, scheme) => `${p}${scheme || ''}***`);
      out = out.replace(/((?:token|password|passwd|secret)=)[^\s&"']+/gi, '$1***');
      out = out.replace(/\/\/([^\/\s:@]+):([^@\s\/]+)@/g, '//$1:***@');
      return out;
    },
  };
}

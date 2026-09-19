import { references } from '../expr.js';

export const BODIES = ['shell', 'js', 'agent', 'human'];
const OUTPUTS = ['keys', 'json', 'text'];
const DO = ['retry', 'agent', 'pause', 'skip_item', 'abort'];
const TERMINAL = ['pause', 'skip_item', 'abort'];

export function bodyKind(step) { return BODIES.find((b) => step[b] !== undefined); }

export function validateTemplate(tpl) {
  const errs = [];
  const err = (p, m) => errs.push({ path: p, message: m });
  if (!tpl || typeof tpl !== 'object') return [{ path: '', message: 'template must be a mapping' }];
  if (!/^[a-z][a-z0-9-]*$/.test(tpl.name || '')) err('name', 'name must match ^[a-z][a-z0-9-]*$');
  if (tpl.items?.source && !['dirs', 'manual', 'queue'].includes(tpl.items.source)) err('items.source', 'must be dirs, manual or queue');
  if (tpl.items?.source === 'queue' && !/^[a-z][a-z0-9-]*$/.test(tpl.items.queue || '')) err('items.queue', 'queue name required, ^[a-z][a-z0-9-]*$');
  for (const m of tpl.modes || []) if (!['all', 'pilot'].includes(m)) err('modes', `unknown mode ${m}`);
  for (const [k, p] of Object.entries(tpl.params || {})) {
    if (p?.type && !['string', 'number', 'boolean'].includes(p.type)) err(`params.${k}.type`, 'must be string|number|boolean');
    if (p?.pattern !== undefined) {
      if (typeof p.pattern !== 'string') err(`params.${k}.pattern`, 'must be a string');
      else { try { new RegExp(p.pattern); } catch { err(`params.${k}.pattern`, 'must be a valid regular expression'); } }
    }
  }
  if (!Array.isArray(tpl.steps) || !tpl.steps.length) { err('steps', 'at least one step required'); return errs; }

  const seen = new Set();
  tpl.steps.forEach((s, i) => {
    const p = `steps[${i}]`;
    if (!s || typeof s !== 'object') { err(p, 'step must be a mapping'); return; }
    if (!/^[a-z][a-z0-9_-]*$/.test(s.name || '')) err(`${p}.name`, 'name required, ^[a-z][a-z0-9_-]*$');
    if (seen.has(s.name)) err(`${p}.name`, `duplicate step name ${s.name}`);
    if (!!s.each === !!s.once) err(p, 'exactly one of each: true / once: true');
    const bodies = BODIES.filter((b) => s[b] !== undefined);
    if (bodies.length !== 1) err(p, `exactly one body of ${BODIES.join('|')}, got ${bodies.join(',') || 'none'}`);
    if (s.output && !OUTPUTS.includes(s.output)) err(`${p}.output`, `must be ${OUTPUTS.join('|')}`);
    if (s.barrier && !s.once) err(`${p}.barrier`, 'barrier only with once');
    if (s.barrier && !['all', 'succeeded'].includes(s.barrier)) err(`${p}.barrier`, 'must be all|succeeded');
    if (s.items !== undefined && !s.once) err(`${p}.items`, 'items only in once step');
    if (s.agent !== undefined) {
      if (!s.verify) err(`${p}.verify`, 'agent step requires verify');
      if (typeof s.agent?.prompt !== 'string') err(`${p}.agent.prompt`, 'prompt required');
    }
    if (s.human !== undefined) {
      if (typeof s.human?.question !== 'string') err(`${p}.human.question`, 'question required');
      if (s.human?.pause_on !== undefined && !Array.isArray(s.human.pause_on)) err(`${p}.human.pause_on`, 'must be a list (empty = never pause)');
      if (s.on_fail) err(`${p}.on_fail`, 'on_fail not applicable to human step');
      if (s.outbound) err(`${p}.outbound`, 'outbound not applicable to human step');
    } else if (s.outbound) {
      const prev = tpl.steps[i - 1];
      if (!prev || prev.human === undefined || !!prev.each !== !!s.each) err(`${p}.outbound`, 'outbound step must directly follow a human step of the same kind (each/once)');
      if (s.outbound !== true && !(Array.isArray(s.outbound) && s.outbound.length && s.outbound.every((a) => typeof a === 'string'))) err(`${p}.outbound`, 'must be true or a non-empty list of confirming answers');
    }
    if (s.on_fail !== undefined && s.human === undefined) {
      if (!Array.isArray(s.on_fail) || !s.on_fail.length) err(`${p}.on_fail`, 'must be a non-empty list');
      else {
        let agentSeen = false;
        s.on_fail.forEach((r, j) => {
          const q = `${p}.on_fail[${j}]`;
          if (!r || !DO.includes(r.do)) { err(q, `do must be ${DO.join('|')}`); return; }
          if (r.do === 'retry') {
            if (!s.retriable) err(q, 'retry requires retriable: true on the step');
            if (!(Number.isInteger(r.times) && r.times > 0)) err(`${q}.times`, 'positive integer required');
          }
          if (r.do === 'agent') {
            if (agentSeen) err(q, 'only one agent rung allowed');
            agentSeen = true;
            if (typeof r.prompt !== 'string') err(`${q}.prompt`, 'prompt required');
            if (r.then !== undefined && r.then !== 'pause') err(`${q}.then`, 'only then: pause is supported');
          }
        });
        const last = s.on_fail[s.on_fail.length - 1];
        if (last && DO.includes(last.do) && !TERMINAL.includes(last.do)) err(`${p}.on_fail`, `last rung must be ${TERMINAL.join('|')}`);
      }
    }
    for (const ref of references(s)) {
      if (!seen.has(ref.step)) err(p, `reference to unknown or later step '${ref.step}' (known so far: ${[...seen].join(', ') || 'none'})`);
    }
    seen.add(s.name);
  });
  return errs;
}

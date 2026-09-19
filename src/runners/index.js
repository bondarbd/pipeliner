import * as shell from './shell.js';
import * as js from './js.js';
import * as human from './human.js';

export async function defaultRunners() {
  let agent;
  try { agent = await import('./agent.js'); }
  catch { agent = { run: async () => ({ ok: false, error: 'agent runner not installed' }) }; }
  return { shell, js, human, agent };
}

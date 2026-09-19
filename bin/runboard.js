#!/usr/bin/env node
import { parseArgs } from '../src/cli/table.js';
import { defaultHome, loadConfig } from '../src/config.js';
import * as c from '../src/cli/commands.js';

const args = parseArgs(process.argv.slice(2));
const cmd = args._.shift();
const commands = { init: c.init, doctor: c.doctor, validate: c.validate, render: c.renderCmd, run: c.run, list: c.list, show: c.show, retry: c.retry, answer: c.answer, clean: c.clean, serve: c.serve };
if (!commands[cmd]) {
  console.log(`usage: runboard <${Object.keys(commands).join('|')}> [args]\n  run <template> [--param k=v]... [--items a,b] [--mode all|pilot] [--dry-run] [--yes]\n  render <template> --step S [--item I] [--param k=v]\n  retry <run> <item|_> <step>    answer <run> <item|_|__pilot__> <step|-> <text>`);
  process.exit(cmd ? 1 : 0);
}
const home = defaultHome();
const io = { home, config: loadConfig(home), out: (s) => console.log(s), err: (s) => console.error(s), answer: args.answer };
commands[cmd](args, io).then((code) => process.exit(code ?? 0), (e) => { console.error(e.message); process.exit(1); });

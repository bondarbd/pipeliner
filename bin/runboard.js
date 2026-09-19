#!/usr/bin/env node
import { parseArgs } from '../src/cli/table.js';
import { defaultHome, loadConfig } from '../src/config.js';
import * as c from '../src/cli/commands.js';

const args = parseArgs(process.argv.slice(2));
const cmd = args._.shift();
const commands = { init: c.init, doctor: c.doctor, validate: c.validate, render: c.renderCmd, run: c.run, list: c.list, show: c.show, log: c.log,
  retry: c.retry, skip: c.skip, abort: c.abort, answer: c.answer, board: c.board,
  add: c.add, queue: c.queueCmd, done: c.done, snooze: c.snooze, drop: c.drop, clean: c.clean, serve: c.serve };
if (!commands[cmd]) {
  console.log(`usage: runboard <${Object.keys(commands).join('|')}> [args]
  run <template> [--param k=v]... [--items a,b] [--mode all|pilot] [--dry-run] [--yes] [--answer TEXT]
  render <template> --step S [--item I] [--param k=v]
  show <run>                       log <run> <item|_> <step> [--kind log|check|verify|diagnose|diff] [--bytes N]
  retry <run> <item|_> <step>      skip <run> <item|_> <step>      abort <run> [item]
  answer <run> <item|_|__pilot__> <step|-> <text>
  board [--all]                    add <queue> <text…|-> [--link URL]      queue [name]
  done <queue> <id>                snooze <queue> <id> [tomorrow|monday|week|YYYY-MM-DD]      drop <queue> <id>`);
  process.exit(cmd ? 1 : 0);
}
const home = defaultHome();
const io = { home, config: loadConfig(home), out: (s) => console.log(s), err: (s) => console.error(s), answer: args.answer };
commands[cmd](args, io).then((code) => process.exit(code ?? 0), (e) => { console.error(e.message); process.exit(1); });

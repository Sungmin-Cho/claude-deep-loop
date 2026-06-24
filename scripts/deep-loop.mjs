#!/usr/bin/env node
import { error } from './lib/log.mjs';

const [, , sub, ...rest] = process.argv;

const handlers = {
  validate: async () => { process.stdout.write('ok\n'); return 0; },
};

const fn = handlers[sub];
if (!fn) { error(`unknown subcommand: ${sub ?? '<none>'}`); process.exit(2); }
process.exit(await fn(rest));

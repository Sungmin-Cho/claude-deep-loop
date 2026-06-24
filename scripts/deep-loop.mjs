#!/usr/bin/env node
import { error } from './lib/log.mjs';
import { initRun } from './lib/initrun.mjs';
import { detectPlugins } from './lib/detect.mjs';
import { matchRecipe } from './lib/recipes.mjs';
import { json } from './lib/log.mjs';

function parseFlags(argv) {
  const f = {}; for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i]; f[k] = v; } } return f;
}

const [, , sub, ...rest] = process.argv;

const handlers = {
  validate: async () => { process.stdout.write('ok\n'); return 0; },
  'detect-plugins': async () => { json(detectPlugins(process.cwd())); return 0; },
  'recipe-match': async (a) => { const f = parseFlags(a); json(matchRecipe(f.goal || '', detectPlugins(process.cwd()))); return 0; },
  'init-run': async (a) => {
    const f = parseFlags(a);
    const { runId } = initRun(process.cwd(), { goal: f.goal, protocol: f.protocol, recipe: f.recipe, detected: detectPlugins(process.cwd()), review: f.review ? JSON.parse(f.review) : undefined });
    json({ run_id: runId }); return 0;
  },
};

const fn = handlers[sub];
if (!fn) { error(`unknown subcommand: ${sub ?? '<none>'}`); process.exit(2); }
process.exit(await fn(rest));

#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { error } from './lib/log.mjs';
import { initRun, buildInitialLoop } from './lib/initrun.mjs';
import { detectPlugins } from './lib/detect.mjs';
import { matchRecipe } from './lib/recipes.mjs';
import { json } from './lib/log.mjs';
import { validate as validateLoop } from './lib/schema.mjs';
import { readState } from './lib/state.mjs';

function parseFlags(argv) {
  const f = {}; for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i]; f[k] = v; } } return f;
}

const [, , sub, ...rest] = process.argv;

// validate: 비공허 검증 (Codex impl 🟡4)
// 1) 스키마+빌더 self-test: buildInitialLoop 산출물이 항상 검증 통과해야 함 (regression 게이트)
// 2) 현재/지정 run이 있으면 readState(해시 검증 발화) + schema.validate
const handlers = {
  validate: async (a) => {
    const f = parseFlags(a);
    const errors = [];
    const sample = buildInitialLoop({ goal: 'self-test', protocol: 'standalone', recipe: { id: 'r', name: 'r', reason: '' }, runId: 'SELFTEST00000000000000000T', now: new Date() });
    const sv = validateLoop(sample);
    if (!sv.ok) errors.push(`builder self-test: ${sv.errors.join('; ')}`);
    const root = f['project-root'] || process.cwd();
    const currentPath = join(root, '.deep-loop', 'current');
    const runId = f['run-id'] || (existsSync(currentPath) ? readFileSync(currentPath, 'utf8').trim() : null);
    if (runId) {
      try {
        const { data } = readState(root, runId);   // 해시 anchor 검증 발화
        const rv = validateLoop(data);
        if (!rv.ok) errors.push(`run ${runId}: ${rv.errors.join('; ')}`);
      } catch (e) { errors.push(`run ${runId}: ${e.message}`); }
    }
    if (errors.length) { error(`validate failed:\n - ${errors.join('\n - ')}`); return 1; }
    process.stdout.write(`ok${runId ? ` (run ${runId})` : ' (schema+builder self-test)'}\n`);
    return 0;
  },
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

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { contentHash } from './envelope.mjs';
import { runDir } from './state.mjs';

const logPath = (root, runId) => join(runDir(root, runId), 'event-log.jsonl');

function readLines(root, runId) {
  const p = logPath(root, runId);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function checksumFor(seq, ts, type, data, prev) {
  return contentHash(`${seq}|${ts}|${type}|${JSON.stringify(data)}|${prev}`);
}

export function appendEvent(root, runId, { type, data }) {
  const lines = readLines(root, runId);
  const prev = lines.length ? lines[lines.length - 1].checksum : 'GENESIS';
  const seq = lines.length + 1;
  const ts = new Date().toISOString();
  const checksum = checksumFor(seq, ts, type, data, prev);
  appendFileSync(logPath(root, runId), JSON.stringify({ seq, ts, type, data, checksum }) + '\n');
}

export function verifyLog(root, runId) {
  const lines = readLines(root, runId);
  const errors = [];
  let prev = 'GENESIS';
  lines.forEach((e, i) => {
    if (e.seq !== i + 1) errors.push(`seq gap at ${i + 1}`);
    if (e.checksum !== checksumFor(e.seq, e.ts, e.type, e.data, prev)) errors.push(`checksum break at seq ${e.seq}`);
    prev = e.checksum;
  });
  return { ok: errors.length === 0, errors };
}

export function recomputeSpent(root, runId) {
  return readLines(root, runId).filter(e => e.type === 'cost')
    .reduce((acc, e) => ({ turns: acc.turns + (e.data.turns || 0), tokens: acc.tokens + (e.data.tokens || 0) }), { turns: 0, tokens: 0 });
}

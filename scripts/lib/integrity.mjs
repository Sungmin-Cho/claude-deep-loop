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
    if (e.type === 'cost' && !validCost(e.data)) errors.push(`invalid cost data at seq ${e.seq}`);
    prev = e.checksum;
  });
  return { ok: errors.length === 0, errors };
}

// cost turns/tokens는 유한 비음수만 허용 (음수 주입으로 spent를 낮추는 우회 차단, Codex impl 🔴2)
export function validCost(d) {
  return d && Number.isFinite(d.turns) && d.turns >= 0 && Number.isFinite(d.tokens) && d.tokens >= 0;
}

export function recomputeSpent(root, runId) {
  return readLines(root, runId).filter(e => e.type === 'cost').reduce((acc, e) => {
    if (!validCost(e.data)) throw new Error(`LOG_CORRUPT: invalid cost event at seq ${e.seq}`);
    return { turns: acc.turns + e.data.turns, tokens: acc.tokens + e.data.tokens };
  }, { turns: 0, tokens: 0 });
}

// 마지막 이벤트의 head {seq, checksum} (빈 로그면 GENESIS) — loop.json 앵커와 대조용 (Codex impl 🔴3)
export function lastLogHead(root, runId) {
  const lines = readLines(root, runId);
  return lines.length ? { seq: lines[lines.length - 1].seq, checksum: lines[lines.length - 1].checksum } : { seq: 0, checksum: 'GENESIS' };
}

// 실제 로그 tail이 기대 head와 일치하는지 — suffix truncation 탐지
export function verifyHead(root, runId, expected) {
  const exp = expected || { seq: 0, checksum: 'GENESIS' };
  const head = lastLogHead(root, runId);
  if (head.seq !== exp.seq || head.checksum !== exp.checksum) {
    return { ok: false, errors: [`log head ${head.seq}/${head.checksum} != anchor ${exp.seq}/${exp.checksum}`] };
  }
  return { ok: true, errors: [] };
}

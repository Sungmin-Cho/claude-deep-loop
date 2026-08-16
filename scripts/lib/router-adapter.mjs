const IDENTITY_KEYS = ['route_schema_version', 'router_plugin_version', 'policy_sha256'];
const ROUTING_KEYS = [
  'request', 'decision', 'selected_model', 'selected_effort_native', 'effective_policy', 'provenance',
];
const PROVENANCE = new Set(['router', 'local-fallback']);
const HIGH_BANDS = new Set(['HIGH', 'CRITICAL']);
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,127}$/;

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function parseDecision(stdout) {
  const trimmed = String(stdout ?? '').trim();
  if (!trimmed) return { error: 'empty-stdout' };
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { return { error: 'non-json' }; }
  const decision = asObject(parsed);
  if (!decision) return { error: 'non-json' };
  if (decision.route_schema_version !== 1) return { error: 'unsupported-schema', decision };
  return { decision };
}

function baseOutcome({
  status, degrade_reason, localBand, decision = null, write_retry_forbidden = false,
  dispatch_authorized = false, routing_provenance = 'local-fallback', degrade_forbidden = false,
}) {
  return {
    dispatch_authorized,
    status,
    degrade_reason,
    risk_band: decision?.risk_band ?? localBand ?? null,
    local_floor_applied: asObject(decision?.effective_policy) || {},
    routing_provenance,
    write_retry_forbidden,
    degrade_forbidden,
    decision,
  };
}

function unauthorizedProcess({ processState, stderr, python3Available, cliPath, localBand }) {
  if (processState === 'TERMINATION_UNCONFIRMED' || /TERMINATION_UNCONFIRMED/.test(String(stderr || ''))) {
    return baseOutcome({
      status: 'internal', degrade_reason: 'termination_unconfirmed', localBand, write_retry_forbidden: true,
    });
  }
  if (python3Available === false) {
    return baseOutcome({ status: 'unavailable', degrade_reason: 'python3-unavailable', localBand });
  }
  if (!cliPath) {
    return baseOutcome({ status: 'unavailable', degrade_reason: 'router-missing', localBand });
  }
  if (processState === 'spawn_failed') {
    return baseOutcome({ status: 'unavailable', degrade_reason: 'spawn_failed', localBand });
  }
  if (processState === 'permission_denied') {
    return baseOutcome({ status: 'unavailable', degrade_reason: 'permission_denied', localBand });
  }
  if (processState === 'timeout') {
    return baseOutcome({ status: 'internal', degrade_reason: 'timeout', localBand });
  }
  if (processState === 'signaled') {
    return baseOutcome({ status: 'internal', degrade_reason: 'signal', localBand });
  }
  return null;
}

// Complete §11.3 translation. Process failures and identity mismatches are the
// same consumer class as exit 2: no authorized route, never silent-main.
export function translateRouteOutcome({
  exit, stdout, stderr, processState,
  frozenDigest = null,
  localBand = null,
  python3Available = true,
  cliPath = true,
} = {}) {
  const blocked = unauthorizedProcess({ processState, stderr, python3Available, cliPath, localBand });
  if (blocked) return blocked;

  if (exit == null || !Number.isInteger(exit) || exit < 0 || exit > 5) {
    return baseOutcome({ status: 'internal', degrade_reason: 'exit-out-of-range', localBand });
  }

  const parsed = parseDecision(stdout);
  if (parsed.error === 'empty-stdout' || parsed.error === 'non-json') {
    return baseOutcome({ status: parsed.error === 'empty-stdout' ? 'internal' : 'invalid', degrade_reason: parsed.error, localBand });
  }
  if (parsed.error === 'unsupported-schema') {
    return baseOutcome({
      status: 'invalid', degrade_reason: 'unsupported-schema', localBand, decision: parsed.decision,
    });
  }

  const decision = parsed.decision;
  if (frozenDigest && decision.policy_sha256 && decision.policy_sha256 !== frozenDigest) {
    return baseOutcome({
      status: 'invalid', degrade_reason: 'digest-mismatch', localBand, decision,
    });
  }

  if (exit === 0) {
    return baseOutcome({
      status: 'ok', degrade_reason: null, localBand, decision,
      dispatch_authorized: true, routing_provenance: 'router',
    });
  }
  if (exit === 4) {
    return baseOutcome({
      status: 'deferred_confirm', degrade_reason: null, localBand, decision,
      dispatch_authorized: true, routing_provenance: 'router', degrade_forbidden: true,
    });
  }
  if (exit === 3) {
    return baseOutcome({
      status: 'human_gate', degrade_reason: 'human_gate', localBand, decision,
      routing_provenance: 'router', degrade_forbidden: true,
    });
  }
  if (exit === 1) {
    return baseOutcome({ status: 'terminal', degrade_reason: 'terminal', localBand, decision });
  }
  if (exit === 2) {
    return baseOutcome({ status: 'invalid', degrade_reason: 'invalid-input', localBand, decision });
  }
  return baseOutcome({ status: 'internal', degrade_reason: 'internal', localBand, decision });
}

export function mayRecordInProgress(outcome) {
  if (!outcome || outcome.write_retry_forbidden) return false;
  if (outcome.status === 'human_gate' || (outcome.degrade_forbidden && !outcome.dispatch_authorized)) return false;
  if (outcome.dispatch_authorized) return true;
  return !HIGH_BANDS.has(outcome.risk_band);
}

export function shouldAttachRouting(outcome) {
  return outcome?.dispatch_authorized === true && outcome.routing_provenance === 'router';
}

export function buildRoutingRecord(request, decision, { provenance = 'router' } = {}) {
  const src = asObject(decision) || {};
  return {
    request: asObject(request) || {},
    decision: {
      route_schema_version: src.route_schema_version,
      router_plugin_version: src.router_plugin_version,
      policy_sha256: src.policy_sha256,
    },
    selected_model: src.selected_model,
    selected_effort_native: src.selected_effort_native,
    effective_policy: asObject(src.effective_policy) || {},
    provenance,
  };
}

export function isRoutingRecord(value) {
  const routing = asObject(value);
  if (!routing) return false;
  if (!ROUTING_KEYS.every((key) => Object.hasOwn(routing, key))) return false;
  if (!PROVENANCE.has(routing.provenance)) return false;
  if (!asObject(routing.request) || !asObject(routing.effective_policy)) return false;
  if (typeof routing.selected_model !== 'string' || !SAFE_TOKEN.test(routing.selected_model)) return false;
  if (typeof routing.selected_effort_native !== 'string' || !SAFE_TOKEN.test(routing.selected_effort_native)) return false;
  const decision = asObject(routing.decision);
  if (!decision) return false;
  if (!IDENTITY_KEYS.every((key) => Object.hasOwn(decision, key))) return false;
  if (decision.route_schema_version !== 1) return false;
  if (typeof decision.router_plugin_version !== 'string' || !decision.router_plugin_version) return false;
  return SHA256.test(decision.policy_sha256 || '');
}

export function assertRoutingRecord(value) {
  if (!isRoutingRecord(value)) throw new Error('EPISODE_ROUTING_INVALID');
  return value;
}

export function frozenPolicyDigest(loop) {
  for (const episode of loop?.episodes || []) {
    const digest = episode?.routing?.decision?.policy_sha256;
    if (typeof digest === 'string' && SHA256.test(digest)) return digest;
  }
  return null;
}

export function assertRoutingDigest(loop, routing) {
  const frozen = frozenPolicyDigest(loop);
  const next = routing?.decision?.policy_sha256;
  if (frozen && next && frozen !== next) throw new Error('EPISODE_ROUTING_DIGEST_MISMATCH');
}

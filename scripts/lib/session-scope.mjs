const WORKSTREAM_TERMINAL = new Set(['ready', 'merged', 'abandoned']);

function authenticLegacy(loop, scope) {
  return scope?.kind === 'legacy'
    && loop?.autonomy?.continuation_policy !== 'workstream-session';
}

export function ownerSession(loop) {
  const owner = loop?.session_chain?.lease?.owner_run_id;
  const session = Array.isArray(loop?.session_chain?.sessions)
    ? loop.session_chain.sessions.find(item => item?.run_id === owner)
    : null;
  if (!session) throw new Error(`SESSION_SCOPE_MISMATCH: lease owner session not found: ${String(owner)}`);
  return session;
}

export function currentWorkstreamScope(loop) {
  const scope = ownerSession(loop).scope;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)
    || !['workstream', 'legacy'].includes(scope.kind)) {
    throw new Error('SESSION_SCOPE_MISMATCH: lease owner scope is invalid');
  }
  return scope;
}

export function isOpenScope(scope) {
  return scope?.kind === 'workstream'
    && scope.terminal_event === null
    && scope.superseded_at === null;
}

export function reservedOpenScope(loop) {
  const owner = loop?.session_chain?.lease?.owner_run_id;
  const scopes = (Array.isArray(loop?.session_chain?.sessions) ? loop.session_chain.sessions : [])
    .filter(session => session?.run_id !== owner && isOpenScope(session?.scope))
    .map(session => session.scope);
  if (scopes.length > 1) throw new Error('SESSION_SCOPE_MISMATCH: multiple reserved open scopes');
  return scopes[0] ?? null;
}

export function assertScopeAllows(loop, workstreamId, { allowUnbound = false } = {}) {
  if (typeof workstreamId !== 'string' || workstreamId.length === 0) {
    throw new Error('WORKSTREAM_REQUIRED: a non-null Workstream is required');
  }
  const scope = currentWorkstreamScope(loop);
  if (authenticLegacy(loop, scope)) return scope;
  if (!isOpenScope(scope)) {
    throw new Error(`SESSION_SCOPE_MISMATCH: owner scope is closed for ${workstreamId}`);
  }
  if (scope.workstream_id === null && allowUnbound) return scope;
  if (scope.workstream_id !== workstreamId) {
    throw new Error(`SESSION_SCOPE_MISMATCH: ${workstreamId}`);
  }
  return scope;
}

export function bindMakerScope(loop, episode, eventSeq) {
  const scope = currentWorkstreamScope(loop);
  if (authenticLegacy(loop, scope)) return scope;
  if (episode?.role !== 'maker') {
    throw new Error(`SESSION_SCOPE_MISMATCH: checker cannot bind owner scope: ${String(episode?.id)}`);
  }
  const workstreamId = episode.workstream_id;
  if (typeof workstreamId !== 'string' || workstreamId.length === 0) {
    throw new Error(`WORKSTREAM_REQUIRED: ${String(episode?.id)}`);
  }
  const workstream = (loop.workstreams || []).find(item => item.id === workstreamId);
  if (!workstream) throw new Error(`WORKSTREAM_NOT_FOUND: ${workstreamId}`);
  if (WORKSTREAM_TERMINAL.has(workstream.status)) {
    throw new Error(`WORKSTREAM_TERMINAL_LOCKED: ${workstreamId} is ${workstream.status}`);
  }
  assertScopeAllows(loop, workstreamId, { allowUnbound: true });
  if (scope.workstream_id === null) {
    if (!Number.isSafeInteger(eventSeq) || eventSeq < 1) {
      throw new Error('STATE_INVALID: maker scope bind event seq');
    }
    scope.workstream_id = workstreamId;
    scope.bound_at_seq = eventSeq;
  }
  return scope;
}

export function closeScope(loop, workstreamId, terminalEvent, now) {
  const scope = assertScopeAllows(loop, workstreamId);
  if (authenticLegacy(loop, scope)) return scope;
  if (!terminalEvent || typeof terminalEvent !== 'object' || Array.isArray(terminalEvent)
    || !Number.isSafeInteger(terminalEvent.seq) || terminalEvent.seq < 1
    || !/^[0-9a-f]{64}$/.test(terminalEvent.checksum || '')) {
    throw new Error('STATE_INVALID: terminal event identity');
  }
  const timestamp = new Date(now);
  if (!Number.isFinite(timestamp.getTime())) throw new Error('INVALID_NOW: scope close');
  const closedAt = timestamp.toISOString();
  scope.terminal_event = { seq: terminalEvent.seq, checksum: terminalEvent.checksum };
  scope.closed_at = closedAt;
  return scope;
}

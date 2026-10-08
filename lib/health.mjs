const HOUR = 3_600_000;

export function sourceHealth(source, state = { status: 'pending' }, now = Date.now()) {
  if (source?.enabled === false) return { status: 'disabled', label: '已停用', lastSuccessAt: state.lastSuccessAt ?? null, failureCount: state.failureCount ?? 0 };
  const failureCount = Math.max(0, Number(state.failureCount) || 0);
  const lastSuccessAt = state.lastSuccessAt ?? null;
  const lastSuccessTime = lastSuccessAt ? new Date(lastSuccessAt).valueOf() : NaN;
  const ageMs = Number.isFinite(lastSuccessTime) ? Math.max(0, now - lastSuccessTime) : Infinity;
  const staleAfterMs = Math.max(6 * HOUR, (Number(source?.pollMinutes) || 60) * 3 * 60_000);
  let status;
  if (failureCount >= 5 || (lastSuccessAt && ageMs >= 24 * HOUR) || (!lastSuccessAt && failureCount >= 3)) status = 'error';
  else if (lastSuccessAt && (ageMs > staleAfterMs || failureCount >= 2)) status = 'degraded';
  else if (lastSuccessAt) status = 'ok';
  else status = 'pending';
  return {
    status,
    label: { ok: '健康', degraded: '降级', error: '失败', pending: '待首次验证' }[status],
    lastSuccessAt,
    lastAttemptAt: state.lastAttemptAt ?? null,
    lastError: state.lastError ?? null,
    failureCount,
    failureKind: state.failureKind ?? null,
    httpStatus: state.httpStatus ?? null,
    retryAfterAt: state.retryAfterAt ?? null,
    nextPollAt: state.nextPollAt ?? null,
    lastDurationMs: state.lastDurationMs ?? null,
    staleAfterHours: Math.round(staleAfterMs / HOUR),
    ageHours: Number.isFinite(ageMs) ? Math.round(ageMs / HOUR) : null,
    pollMinutes: source?.pollMinutes ?? null
  };
}

export function summarizeSourceHealth(sources, stateFor, now = Date.now()) {
  const enabled = sources.filter((source) => source.enabled !== false);
  const states = enabled.map((source) => sourceHealth(source, stateFor(source.id) ?? { status: 'pending' }, now));
  const count = (status) => states.filter((state) => state.status === status).length;
  const failing = count('error');
  const degradedSources = count('degraded');
  return {
    sources: enabled.length,
    healthy: count('ok'),
    degradedSources,
    failing,
    pending: count('pending'),
    degraded: failing > 0 || degradedSources > 0
  };
}

export function jitteredBackoffMinutes(failureCount, random = Math.random) {
  const base = Math.min(180, 5 * (2 ** Math.max(0, Number(failureCount || 1) - 1)));
  const factor = 0.8 + Math.max(0, Math.min(1, Number(random()) || 0)) * 0.4;
  return Math.max(1, Math.round(base * factor));
}

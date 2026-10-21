/**
 * Whether a cached value is still usable.
 *
 * A lifetime of zero or less means "no automatic expiry": the value lives until the connection closes
 * or the user refreshes by hand. The boundary is exclusive - a value exactly one lifetime old is
 * stale - so a five-minute setting never serves a sixth-minute answer.
 */
export function isFresh(loadedAt: number, ttlMs: number, now: number): boolean {
  return ttlMs <= 0 || now - loadedAt < ttlMs;
}

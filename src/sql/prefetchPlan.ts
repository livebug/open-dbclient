/**
 * How a whole-database prefetch is split into reads.
 *
 * The prefetch behind completion is the one metadata read that can span an entire database. Asking the
 * driver for all of it in one call is what a warehouse with a huge catalog punishes: the driver
 * materialises the whole result before returning the first row, and the bridge's heap is what pays for
 * it. Splitting the read by schema (or by catalog, on the databases whose qualifier level is the
 * catalog) keeps each individual result bounded and lets a `metadata.queries` rule that filters on
 * `${schema}` answer at all - a whole-database read has no schema to fill in.
 *
 * A pure function rather than a loop inside the cache, because the decision is the interesting part and
 * it is the part a test can pin down without a VS Code host or a database.
 */

/** One read of the table listing, narrowed to a schema, a catalog, or neither. */
export interface PrefetchScope {
  readonly schema?: string;
  readonly catalog?: string;
}

/**
 * The reads to issue for one connection.
 *
 * @param schemas schemas the connection reports, in the order the driver returned them
 * @param catalogs catalogs to fall back to when there is no schema level, ignored otherwise
 * @param catalogIsFixed true when the connection names its own catalog (a driver that cannot read
 *                       across catalogs); splitting by catalog would then be wrong, not just slow
 */
export function prefetchScopes(
  schemas: readonly string[],
  catalogs: readonly string[],
  catalogIsFixed: boolean,
): readonly PrefetchScope[] {
  if (schemas.length > 1) {
    return schemas.map((schema) => ({ schema }));
  }
  if (!catalogIsFixed && catalogs.length > 1) {
    return catalogs.map((catalog) => ({ catalog }));
  }
  if (schemas.length === 0 && catalogIsFixed) {
    // The connection names one catalog it can read inside, and no schema came back. Falling through to
    // `[{}]` would ask the driver for every table of that catalog in one call, which is the read that
    // materialises a warehouse in the bridge's heap. An empty list here means "do not read", and the
    // caller reports it instead.
    return [];
  }
  return [{}];
}

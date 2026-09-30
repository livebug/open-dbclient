import type { TableInfo } from '../bridge/protocol';

/**
 * One field a metadata rule returned for a table, beyond the names JDBC itself has columns for.
 *
 * The point of allowing these is that a rule is written by someone who knows their database, and the
 * catalog tables they are reading often carry more than a name: an estimated row count, a storage
 * engine, a partitioning scheme, a lifecycle status. None of that fits in `TableInfo`, and inventing a
 * field per possibility would mean a new extension release per database.
 */
export interface TableDetail {
  /** The result column name, as the statement aliased it. */
  readonly name: string;
  readonly value: string;
}

/**
 * A table as the tree describes it.
 *
 * Extends the protocol's `TableInfo` rather than replacing it: everything the bridge sends is still
 * exactly that, and only a rule can add details - they are the extension's own enrichment, filled in from
 * the rows a rule returned, and they never travel over the protocol.
 */
export interface DescribedTable extends TableInfo {
  readonly details?: readonly TableDetail[];
}

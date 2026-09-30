/**
 * Whether the connection tree should show a catalog level, and what to read below it.
 *
 * <h2>Why this is a decision and not a line of code</h2>
 *
 * JDBC's three-level model - catalog, schema, table - is not a description of every database. On MySQL the
 * "catalog" is the database and the driver honours it everywhere; on PostgreSQL and openGauss the driver
 * lists every database in the cluster as a catalog and then *ignores* the catalog argument, because a
 * connection cannot read across databases at all.
 *
 * <p>That difference is not cosmetic. Measured against PostgreSQL 16 with pgjdbc 42.7.4, connected to
 * `postgres`:
 *
 * <pre>
 *   getCatalogs()                      → otherdb, postgres, template1
 *   getTables(catalog = "postgres")    → main_tbl      (the connected database)
 *   getTables(catalog = "otherdb")     → main_tbl      (the *connected* database again)
 *   getTables(catalog = "nope")        → main_tbl      (and again)
 * </pre>
 *
 * <p>So a tree that shows a node per catalog would show the same tables under three names, two of which
 * claim to be somewhere else - a wrong answer rather than a missing feature, and the kind this project
 * refuses to ship. On MariaDB the same probe gives `t1`, `t2` and nothing for an unknown name: the level
 * means what it says.
 *
 * <p>The driver already knows which of the two it is: `supportsCatalogsInDataManipulation()` answers false
 * on PostgreSQL and true on MySQL and SQL Server. Asking it keeps this a capability check rather than a
 * dialect branch - the same rule the rest of this project follows.
 */

/** What the tree should do with the catalogs a connection can see. */
export interface CatalogLevel {
  /** True to show one node per catalog, which is what makes the level worth having. */
  readonly show: boolean;
  /**
   * The catalog to read the rest of the tree from when the level is skipped.
   *
   * Undefined means "whatever the connection is already pointed at", which is the right answer for a driver
   * that has no usable catalog at all.
   */
  readonly catalog?: string;
}

/**
 * Decides the catalog level.
 *
 * @param catalogs the names the driver reported, in the order it reported them
 * @param driverSupportsCatalogs `supportsCatalogsInDataManipulation` - whether a catalog name means
 *                              anything to the driver when it reads
 */
export function catalogLevel(
  catalogs: readonly string[],
  driverSupportsCatalogs: boolean,
): CatalogLevel {
  if (driverSupportsCatalogs && catalogs.length > 1) {
    return { show: true };
  }

  // One catalog is a level with a single redundant node in it, so it is skipped and the name is carried
  // down instead. Several catalogs that the driver cannot read inside - the PostgreSQL case - are skipped
  // for a stronger reason: there is nothing behind them.
  return { show: false, catalog: catalogs.length === 1 ? catalogs[0] : undefined };
}

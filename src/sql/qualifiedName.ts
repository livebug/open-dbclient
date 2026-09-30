/**
 * Table names, and the parts of them a metadata read needs.
 *
 * Two questions live here, both of them pure - which is why they are not inside the cache that asks them:
 *
 * - How does a name written in a statement split into catalog, schema and table?
 * - When the statement named no schema at all, which schema does that name belong to?
 *
 * The second one is answered from the table listing the completion list is built from, and it matters for
 * more than tidiness: a `metadata.queries` rule that filters on `${schema}` or `${schemaLiteral}` cannot be
 * filled without a schema, and an unfillable placeholder refuses the rule and falls back to the driver's own
 * metadata - which is the slow path the rule was written to avoid.
 */

/** A table name split into the parts a metadata call takes. */
export interface QualifiedTableName {
  /** Everything before the schema, for a three-part name like `db.public.users`. */
  readonly catalog?: string;
  readonly schema?: string;
  /** The trailing part, which is what a driver matches its table names against. */
  readonly table: string;
}

/** One qualifier a table can be reached through, as the completion cache holds them. */
export interface QualifierOwner {
  readonly name: string;
  readonly kind: 'schema' | 'catalog';
  readonly tables: readonly string[];
}

/**
 * Splits a possibly qualified name into catalog, schema and table.
 *
 * JDBC's `getColumns(catalog, schema, tableNamePattern, ...)` matches its pattern against the bare table
 * name, so handing it `public.users` asks for a table literally called that - which is how a statement
 * written `FROM public.users` ended up offering no columns at all, and, while an empty answer was not
 * remembered, asked the database the same question again on every keystroke.
 *
 * The last part is always the table, the one before it the schema, and anything to the left of that is the
 * catalog. A quoted identifier that contains a dot is indistinguishable from a separator by the time this
 * runs - the scanner strips the quotes as it joins the parts - so it is treated as one, which is the same
 * limitation the rest of the completion path has.
 */
export function parseQualifiedName(name: string): QualifiedTableName {
  const parts = name
    .split('.')
    .map((part) => part.trim())
    .filter((part) => part !== '');

  const table = parts.pop() ?? '';
  const schema = parts.pop();
  return { catalog: parts.length > 0 ? parts.join('.') : undefined, schema, table };
}

/**
 * The schema a bare table name belongs to, or undefined when the listing does not say.
 *
 * Only an unambiguous answer is used. A name that two schemas both contain stays schema-less, so the driver
 * searches both - which is what it would have done anyway - and a name the listing does not know at all, a
 * table created since it was read, falls back to the connection's own schema when there is exactly one.
 */
export function schemaForTable(
  qualifiers: readonly QualifierOwner[],
  defaultSchema: string | undefined,
  table: string,
): string | undefined {
  const needle = table.toLowerCase();
  const owners = qualifiers.filter(
    (qualifier) =>
      qualifier.kind === 'schema' &&
      qualifier.tables.some((name) => name.toLowerCase() === needle),
  );

  if (owners.length === 1) {
    return owners[0].name;
  }
  return owners.length === 0 ? defaultSchema : undefined;
}

/**
 * The same, for a name that may already carry its own schema.
 *
 * Written as one step because every caller has the qualified name in hand: splitting it and then looking up
 * the missing half is the whole job.
 */
export function scopeOfTable(
  name: QualifiedTableName,
  qualifiers: readonly QualifierOwner[],
  defaultSchema: string | undefined,
): QualifiedTableName {
  if (name.schema !== undefined) {
    return name;
  }
  return { ...name, schema: schemaForTable(qualifiers, defaultSchema, name.table) };
}

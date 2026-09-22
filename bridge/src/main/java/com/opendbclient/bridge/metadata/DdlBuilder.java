package com.opendbclient.bridge.metadata;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.opendbclient.bridge.conn.MetadataSupport;
import com.opendbclient.bridge.log.Log;
import com.opendbclient.bridge.rpc.Protocol;
import com.opendbclient.bridge.rpc.RpcException;

/**
 * Assembles {@code CREATE TABLE} statements from JDBC metadata.
 *
 * <p>Databases advertise their DDL in mutually incompatible ways: MySQL has {@code SHOW CREATE
 * TABLE}, PostgreSQL has {@code pg_get_tabledef}, Oracle has {@code DBMS_METADATA}. Supporting any
 * of them would mean writing dialect code, and supporting all of them would mean writing a lot.
 *
 * <p>Instead the statement is reconstructed from the metadata the driver already exposes - columns,
 * primary keys, foreign keys - and emitted as standard SQL. It is a faithful description of the
 * table rather than a byte-exact copy of how it was originally created: physical storage clauses,
 * tablespaces and engine options do not survive the round trip. For reading a schema, which is the
 * point, that is the right trade.
 *
 * <p>Deliberately absent are {@code COMMENT ON} and index clauses embedded in the table body, since
 * both are dialect-specific. Column remarks are attached as line comments and indexes follow as
 * separate statements, so the output stays executable everywhere.
 */
public final class DdlBuilder {

    private DdlBuilder() {
    }

    /**
     * Builds the DDL for one table.
     *
     * @throws RpcException with {@code NOT_FOUND} when the driver reports no columns, which usually
     *                      means the table name did not resolve
     */
    public static String createTable(
            Connection connection,
            String catalog,
            String schema,
            String table) throws SQLException {

        DatabaseMetaData meta = connection.getMetaData();
        List<ColumnInfo> columns = MetadataProvider.columns(connection, catalog, schema, table);
        if (columns.isEmpty()) {
            throw new RpcException(Protocol.ERROR_NOT_FOUND,
                    "the driver reported no columns for '" + table
                            + "', so no DDL could be generated (is the name correct?)");
        }

        String quote = MetadataSupport.identifierQuote(meta);
        StringBuilder ddl = new StringBuilder(512);

        ddl.append("CREATE TABLE ").append(qualifiedName(quote, schema, table)).append(" (\n");

        // The table body is assembled as elements first, then emitted with commas inserted before
        // any trailing comment. Interleaving the two while appending is how a comma ends up after a
        // line comment, producing SQL that no database will parse.
        List<Element> elements = new ArrayList<>();
        for (ColumnInfo column : columns) {
            elements.add(new Element(columnDefinition(column, quote), columnComment(column)));
        }

        List<String> primaryKey = new ArrayList<>();
        for (ColumnInfo column : columns) {
            if (column.primaryKey()) {
                primaryKey.add(identifier(quote, column.name()));
            }
        }
        if (!primaryKey.isEmpty()) {
            elements.add(new Element("PRIMARY KEY (" + String.join(", ", primaryKey) + ")", null));
        }
        for (String foreignKey : foreignKeyClauses(connection, catalog, schema, table, quote)) {
            elements.add(new Element(foreignKey, null));
        }

        for (int i = 0; i < elements.size(); i++) {
            Element element = elements.get(i);
            ddl.append("    ").append(element.sql());
            if (i < elements.size() - 1) {
                ddl.append(',');
            }
            if (element.comment() != null && !element.comment().isBlank()) {
                ddl.append(" -- ").append(singleLine(element.comment()));
            }
            ddl.append('\n');
        }

        ddl.append(')');

        appendIndexes(ddl, connection, catalog, schema, table, quote);
        return ddl.toString();
    }

    // ------------------------------------------------------------------
    // internals
    // ------------------------------------------------------------------

    /**
     * Renders one column definition: name, type, nullability and default.
     *
     * <p>Auto-increment keywords are deliberately absent. The standard spelling is {@code GENERATED
     * ... AS IDENTITY}, MySQL wants {@code AUTO_INCREMENT}, PostgreSQL wants {@code SERIAL} or an
     * identity clause, and Oracle wants neither. Guessing would produce DDL that fails on some
     * databases, so the fact is reported as a comment instead.
     */
    private static String columnDefinition(ColumnInfo column, String quote) {
        StringBuilder text = new StringBuilder();
        text.append(identifier(quote, column.name())).append(' ').append(column.displayType());
        if (column.nullableKnown() && !column.nullable()) {
            text.append(" NOT NULL");
        }
        if (column.defaultValue() != null && !column.defaultValue().isBlank()) {
            text.append(" DEFAULT ").append(column.defaultValue());
        }
        return text.toString();
    }

    /**
     * Facts about a column that standard SQL cannot express, folded into one line comment.
     *
     * <p>Primary key membership is not repeated here: the constraint clause at the end of the table
     * body already states it, and saying it twice reads like two separate facts.
     */
    private static String columnComment(ColumnInfo column) {
        List<String> notes = new ArrayList<>(2);
        if (column.autoIncrement()) {
            notes.add("auto-increment");
        }
        if (column.generated()) {
            notes.add("generated");
        }
        if (column.remarks() != null && !column.remarks().isBlank()) {
            notes.add(column.remarks());
        }
        return notes.isEmpty() ? null : String.join("; ", notes);
    }

    /** One line of the table body, plus an optional comment emitted after its comma. */
    private record Element(String sql, String comment) {
    }

    /**
     * Builds {@code FOREIGN KEY} clauses, one per constraint.
     *
     * <p>{@code getImportedKeys} returns one row per column pair, so rows are grouped by constraint
     * name first. Without grouping, a two-column foreign key would be emitted as two separate
     * single-column constraints, which means something different.
     */
    private static List<String> foreignKeyClauses(
            Connection connection,
            String catalog,
            String schema,
            String table,
            String quote) {

        List<String> clauses = new ArrayList<>();
        Map<String, ForeignKey> groups = new LinkedHashMap<>();

        try (ResultSet rows = connection.getMetaData().getImportedKeys(catalog, schema, table)) {
            while (rows.next()) {
                String fkName = readString(rows, "FK_NAME");
                String pkTable = readString(rows, "PKTABLE_NAME");
                String pkSchema = readString(rows, "PKTABLE_SCHEM");
                String fkColumn = readString(rows, "FKCOLUMN_NAME");
                String pkColumn = readString(rows, "PKCOLUMN_NAME");
                if (fkColumn == null || pkColumn == null || pkTable == null) {
                    continue;
                }

                // A null constraint name is legal; group such rows under a synthetic key so they
                // still collapse into one clause per referenced table.
                String key = fkName != null ? fkName : "(unnamed)->" + pkSchema + '.' + pkTable;
                ForeignKey foreignKey = groups.computeIfAbsent(
                        key, ignored -> new ForeignKey(fkName, pkSchema, pkTable));
                foreignKey.columns.add(identifier(quote, fkColumn));
                foreignKey.referencedColumns.add(identifier(quote, pkColumn));
            }
        } catch (SQLException | RuntimeException failure) {
            Log.debug("foreign key lookup failed for %s: %s", table, failure.getMessage());
            return clauses;
        }

        for (ForeignKey foreignKey : groups.values()) {
            StringBuilder clause = new StringBuilder();
            if (foreignKey.name != null && !foreignKey.name.isBlank()) {
                clause.append("CONSTRAINT ").append(identifier(quote, foreignKey.name)).append(' ');
            }
            clause.append("FOREIGN KEY (").append(String.join(", ", foreignKey.columns)).append(") ")
                    .append("REFERENCES ").append(qualifiedName(quote, foreignKey.schema, foreignKey.table))
                    .append(" (").append(String.join(", ", foreignKey.referencedColumns)).append(')');
            clauses.add(clause.toString());
        }
        return clauses;
    }

    /**
     * Appends index definitions as standalone statements.
     *
     * <p>These live outside the table body because index syntax is far from uniform: MySQL inlines
     * {@code KEY ...} clauses, PostgreSQL wants a separate {@code CREATE INDEX}, and the JDBC
     * metadata does not say which form the original used.
     */
    private static void appendIndexes(
            StringBuilder ddl,
            Connection connection,
            String catalog,
            String schema,
            String table,
            String quote) {

        List<IndexInfo> indexes = new ArrayList<>();
        try {
            indexes = MetadataProvider.indexes(connection, catalog, schema, table);
        } catch (SQLException | RuntimeException failure) {
            Log.debug("index listing failed for %s: %s", table, failure.getMessage());
        }
        if (indexes.isEmpty()) {
            return;
        }

        // Rebuild index -> ordered columns.
        Map<String, List<IndexInfo>> grouped = new LinkedHashMap<>();
        for (IndexInfo index : indexes) {
            if (index.name() == null || index.name().isBlank()) {
                continue;
            }
            grouped.computeIfAbsent(index.name(), ignored -> new ArrayList<>()).add(index);
        }
        if (grouped.isEmpty()) {
            return;
        }

        ddl.append(";\n\n-- Indexes\n");
        for (List<IndexInfo> columns : grouped.values()) {
            IndexInfo first = columns.get(0);
            columns.sort((a, b) -> Integer.compare(a.ordinal(), b.ordinal()));

            StringBuilder statement = new StringBuilder("CREATE ");
            if (first.unique()) {
                statement.append("UNIQUE ");
            }
            statement.append("INDEX ").append(identifier(quote, first.name()))
                    .append(" ON ").append(qualifiedName(quote, schema, table)).append(" (");
            for (int i = 0; i < columns.size(); i++) {
                if (i > 0) {
                    statement.append(", ");
                }
                statement.append(identifier(quote, columns.get(i).columnName()));
            }
            statement.append(");");
            ddl.append(statement).append('\n');
        }

        // Trailing newline from the loop leaves a stray blank; trim to keep the view tidy.
        while (ddl.length() > 0 && ddl.charAt(ddl.length() - 1) == '\n') {
            ddl.setLength(ddl.length() - 1);
        }
        return;
    }

    /**
     * Quotes an identifier using the database's own quote character.
     *
     * <p>When the driver reports no quoting support, the name is returned bare. Embedded quote
     * characters are doubled, which is the escape rule standard SQL specifies and every mainstream
     * database follows.
     */
    public static String identifier(String quote, String name) {
        if (quote == null || quote.isEmpty() || name == null) {
            return name;
        }
        return quote + name.replace(quote, quote + quote) + quote;
    }

    private static String qualifiedName(String quote, String schema, String table) {
        if (schema == null || schema.isEmpty()) {
            return identifier(quote, table);
        }
        return identifier(quote, schema) + '.' + identifier(quote, table);
    }

    /** Collapses a comment so it cannot terminate the line it is appended to. */
    private static String singleLine(String text) {
        return text.replace('\r', ' ').replace('\n', ' ').trim();
    }

    private static String readString(ResultSet rows, String label) {
        try {
            return rows.getString(label);
        } catch (SQLException | RuntimeException ignored) {
            return null;
        }
    }

    /** Accumulates the columns of one foreign key constraint as the result set is walked. */
    private static final class ForeignKey {

        final String name;
        final String schema;
        final String table;
        final List<String> columns = new ArrayList<>();
        final List<String> referencedColumns = new ArrayList<>();

        ForeignKey(String name, String schema, String table) {
            this.name = name;
            this.schema = schema;
            this.table = table;
        }
    }
}

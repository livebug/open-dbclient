package com.opendbclient.bridge.conn;

import java.sql.DatabaseMetaData;
import java.util.Map;

import com.opendbclient.bridge.json.Json;

/**
 * What the connected database can do, as reported by JDBC itself.
 *
 * <p>This record is the substitute for a dialect layer. Rather than the bridge deciding what a
 * database supports based on its brand, the driver is asked. {@code DatabaseMetaData} already
 * exposes quoting rules, identifier casing, catalog and schema naming, and a large set of
 * {@code supportsXxx} probes, and every JDBC driver implements them - if imperfectly, which is
 * what {@link MetadataSupport} absorbs.
 *
 * <p>Choosing capability detection over dialect dispatch is what lets one code path serve
 * MySQL, PostgreSQL, openGauss and Hive-family engines with no per-vendor code.
 *
 * @param databaseProductName  display name reported by the driver
 * @param databaseProductVersion version string reported by the driver
 * @param driverName           JDBC driver name
 * @param driverVersion        JDBC driver version
 * @param identifierQuoteString quoting character, or {@code null} when the database cannot
 *                             quote identifiers at all (the driver returns a space in that case)
 * @param catalogTerm          what this database calls a catalog, e.g. "database"
 * @param schemaTerm           what this database calls a schema
 * @param catalogSeparator     separator between catalog and table in qualified names
 * @param supportsCatalogs     whether catalogs meaningfully exist
 * @param supportsSchemas      whether schemas meaningfully exist
 * @param storesUpperCaseIdentifiers    unquoted identifiers are folded to upper case
 * @param storesLowerCaseIdentifiers    unquoted identifiers are folded to lower case
 * @param storesMixedCaseIdentifiers    unquoted identifiers preserve their casing
 * @param supportsMixedCaseQuotedIdentifiers quoted identifiers preserve their casing
 * @param maxColumnNameLength  maximum identifier length for columns, 0 when unspecified
 * @param maxTableNameLength   maximum identifier length for tables, 0 when unspecified
 * @param supportsTransactions transactions are supported
 * @param supportsBatchUpdates batch updates are supported
 * @param supportsSavepoints   savepoints are supported
 * @param supportsGetGeneratedKeys generated keys can be retrieved
 * @param supportsMultipleResultSets multiple result sets per statement are supported
 * @param supportsStoredProcedures stored procedures are supported
 * @param readOnly             the connection is read-only
 */
public record DatabaseCapabilities(
        String databaseProductName,
        String databaseProductVersion,
        String driverName,
        String driverVersion,
        String identifierQuoteString,
        String catalogTerm,
        String schemaTerm,
        String catalogSeparator,
        boolean supportsCatalogs,
        boolean supportsSchemas,
        boolean storesUpperCaseIdentifiers,
        boolean storesLowerCaseIdentifiers,
        boolean storesMixedCaseIdentifiers,
        boolean supportsMixedCaseQuotedIdentifiers,
        int maxColumnNameLength,
        int maxTableNameLength,
        boolean supportsTransactions,
        boolean supportsBatchUpdates,
        boolean supportsSavepoints,
        boolean supportsGetGeneratedKeys,
        boolean supportsMultipleResultSets,
        boolean supportsStoredProcedures,
        boolean readOnly) {

    /**
     * Probes a live connection.
     *
     * <p>Every field is read defensively: a driver that does not implement one of these methods
     * degrades to a conservative default instead of failing the connection. This matters because
     * a successful connect should never be reported as failed merely because capability
     * introspection was incomplete.
     */
    public static DatabaseCapabilities read(java.sql.Connection connection) {
        DatabaseMetaData meta = MetadataSupport.value(connection::getMetaData, null);
        if (meta == null) {
            return unknown();
        }

        return new DatabaseCapabilities(
                MetadataSupport.value(meta::getDatabaseProductName, null),
                MetadataSupport.value(meta::getDatabaseProductVersion, null),
                MetadataSupport.value(meta::getDriverName, null),
                MetadataSupport.value(meta::getDriverVersion, null),
                MetadataSupport.identifierQuote(meta),
                MetadataSupport.value(meta::getCatalogTerm, null),
                MetadataSupport.value(meta::getSchemaTerm, null),
                MetadataSupport.value(meta::getCatalogSeparator, null),
                MetadataSupport.flag(meta::supportsCatalogsInDataManipulation, false),
                MetadataSupport.flag(meta::supportsSchemasInDataManipulation, false),
                MetadataSupport.flag(meta::storesUpperCaseIdentifiers, false),
                MetadataSupport.flag(meta::storesLowerCaseIdentifiers, false),
                MetadataSupport.flag(meta::storesMixedCaseIdentifiers, true),
                MetadataSupport.flag(meta::supportsMixedCaseQuotedIdentifiers, true),
                MetadataSupport.integer(meta::getMaxColumnNameLength, 0),
                MetadataSupport.integer(meta::getMaxTableNameLength, 0),
                MetadataSupport.flag(meta::supportsTransactions, true),
                MetadataSupport.flag(meta::supportsBatchUpdates, false),
                MetadataSupport.flag(meta::supportsSavepoints, false),
                MetadataSupport.flag(meta::supportsGetGeneratedKeys, false),
                MetadataSupport.flag(meta::supportsMultipleResultSets, false),
                MetadataSupport.flag(meta::supportsStoredProcedures, false),
                MetadataSupport.flag(connection::isReadOnly, false));
    }

    /** Fallback used when even {@code getMetaData()} is unavailable. */
    public static DatabaseCapabilities unknown() {
        return new DatabaseCapabilities(
                null, null, null, null, null, null, null, null,
                false, false, false, false, true, true, 0, 0,
                true, false, false, false, false, false, false);
    }

    /**
     * Human-readable one-liner, e.g. {@code "PostgreSQL 16.2 via PostgreSQL JDBC Driver 42.7.1"}.
     */
    public String describe() {
        StringBuilder text = new StringBuilder();
        text.append(databaseProductName == null ? "unknown database" : databaseProductName);
        if (databaseProductVersion != null && !databaseProductVersion.isBlank()) {
            text.append(' ').append(databaseProductVersion);
        }
        if (driverName != null && !driverName.isBlank()) {
            text.append(" via ").append(driverName);
            if (driverVersion != null && !driverVersion.isBlank()) {
                text.append(' ').append(driverVersion);
            }
        }
        return text.toString();
    }

    /** Renders this capability set as a JSON payload for the extension. */
    public Map<String, Object> toPayload() {
        Map<String, Object> payload = Json.obj();
        putIfPresent(payload, "databaseProductName", databaseProductName);
        putIfPresent(payload, "databaseProductVersion", databaseProductVersion);
        putIfPresent(payload, "driverName", driverName);
        putIfPresent(payload, "driverVersion", driverVersion);
        putIfPresent(payload, "identifierQuoteString", identifierQuoteString);
        putIfPresent(payload, "catalogTerm", catalogTerm);
        putIfPresent(payload, "schemaTerm", schemaTerm);
        putIfPresent(payload, "catalogSeparator", catalogSeparator);
        payload.put("supportsCatalogs", supportsCatalogs);
        payload.put("supportsSchemas", supportsSchemas);
        payload.put("storesUpperCaseIdentifiers", storesUpperCaseIdentifiers);
        payload.put("storesLowerCaseIdentifiers", storesLowerCaseIdentifiers);
        payload.put("storesMixedCaseIdentifiers", storesMixedCaseIdentifiers);
        payload.put("supportsMixedCaseQuotedIdentifiers", supportsMixedCaseQuotedIdentifiers);
        payload.put("maxColumnNameLength", maxColumnNameLength);
        payload.put("maxTableNameLength", maxTableNameLength);
        payload.put("supportsTransactions", supportsTransactions);
        payload.put("supportsBatchUpdates", supportsBatchUpdates);
        payload.put("supportsSavepoints", supportsSavepoints);
        payload.put("supportsGetGeneratedKeys", supportsGetGeneratedKeys);
        payload.put("supportsMultipleResultSets", supportsMultipleResultSets);
        payload.put("supportsStoredProcedures", supportsStoredProcedures);
        payload.put("readOnly", readOnly);
        payload.put("description", describe());
        return payload;
    }

    private static void putIfPresent(Map<String, Object> target, String key, String value) {
        if (value != null && !value.isBlank()) {
            target.put(key, value);
        }
    }
}

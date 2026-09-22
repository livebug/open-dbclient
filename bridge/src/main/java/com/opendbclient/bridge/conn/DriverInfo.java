package com.opendbclient.bridge.conn;

import java.util.Map;

import com.opendbclient.bridge.json.Json;

/**
 * Describes a JDBC driver that the bridge can instantiate.
 *
 * @param driverClassName fully qualified class name, as passed to {@code Class.forName}
 * @param sourceJar       jar the class was discovered in, or {@code null} when the class name
 *                        was supplied explicitly by the user and the jar is unknown
 * @param version         driver version string, when the driver reports one
 * @param majorVersion    {@code Driver.getMajorVersion()}
 * @param minorVersion    {@code Driver.getMinorVersion()}
 * @param jdbcCompliant   {@code Driver.jdbcCompliant()}
 */
public record DriverInfo(
        String driverClassName,
        String sourceJar,
        String version,
        int majorVersion,
        int minorVersion,
        boolean jdbcCompliant) {

    /**
     * Label shown in the extension's driver list.
     *
     * <p>Derived from the jar file name whenever possible. Taking the last segment of the class
     * name instead produces useless labels for the many drivers whose class is simply
     * {@code JDBC} - {@code org.sqlite.JDBC} would read as "JDBC 3.47", telling the user nothing
     * about which database they are about to connect to.
     */
    public String displayName() {
        String base = baseName();
        return version == null || version.isBlank() ? base : base + " " + version;
    }

    /** The jar name with any trailing version stripped, or the class name as a fallback. */
    private String baseName() {
        if (sourceJar == null || sourceJar.isBlank()) {
            return driverClassName.substring(driverClassName.lastIndexOf('.') + 1);
        }

        String fileName = sourceJar;
        int separator = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'));
        if (separator >= 0) {
            fileName = fileName.substring(separator + 1);
        }
        if (fileName.toLowerCase(java.util.Locale.ROOT).endsWith(".jar")) {
            fileName = fileName.substring(0, fileName.length() - 4);
        }

        // Strip a trailing version such as "-3.47.1.0" or "-42.7.4", but only when what follows
        // the separator is genuinely numeric. This leaves names like "ojdbc11" or
        // "my-2cool-driver" intact instead of truncating them to nonsense.
        String stripped = fileName.replaceFirst("[-_](?=\\d)[0-9][0-9._]*[0-9]?$", "");
        return stripped.isEmpty() ? fileName : stripped;
    }

    public Map<String, Object> toPayload() {
        Map<String, Object> payload = Json.obj(
                "driverClassName", driverClassName,
                "displayName", displayName(),
                "majorVersion", majorVersion,
                "minorVersion", minorVersion,
                "jdbcCompliant", jdbcCompliant);
        if (sourceJar != null) {
            payload.put("sourceJar", sourceJar);
        }
        if (version != null) {
            payload.put("version", version);
        }
        return payload;
    }
}

package com.opendbclient.bridge.conn;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Properties;

import com.opendbclient.bridge.json.Json;

/**
 * Everything needed to open one logical connection, parsed from a request.
 *
 * <p>Deliberately has no notion of database brand. A profile is a driver class name, a JDBC URL,
 * credentials and an open-ended property bag. That is the whole surface area, which is what
 * keeps the extension usable against engines the project has never heard of - openGauss and
 * Transwarp Inceptor included.
 *
 * @param connectionId          caller-chosen stable identifier, also the pool key
 * @param driverClassName       {@code java.sql.Driver} implementation to instantiate
 * @param url                   JDBC URL, passed through to the driver untouched
 * @param user                  user name, or {@code null}
 * @param password              password, or {@code null}
 * @param properties            extra driver properties, forwarded verbatim
 * @param poolSize              maximum pooled connections for this profile
 * @param connectTimeoutSeconds login timeout hint; honoured by drivers that consult
 *                              {@code DriverManager.getLoginTimeout()}
 * @param validationTimeoutSeconds timeout for the {@code Connection.isValid} liveness probe
 * @param maxLifetimeSeconds    connections are recycled after this age
 * @param idleTimeoutSeconds    idle connections beyond the minimum are evicted after this
 */
public record ConnectionProfileSpec(
        String connectionId,
        String driverClassName,
        String url,
        String user,
        String password,
        Map<String, String> properties,
        int poolSize,
        int connectTimeoutSeconds,
        int validationTimeoutSeconds,
        long maxLifetimeSeconds,
        long idleTimeoutSeconds) {

    private static final int DEFAULT_POOL_SIZE = 1;
    private static final int DEFAULT_CONNECT_TIMEOUT_SECONDS = 30;
    private static final int DEFAULT_VALIDATION_TIMEOUT_SECONDS = 5;
    private static final long DEFAULT_MAX_LIFETIME_SECONDS = 1_800L;
    private static final long DEFAULT_IDLE_TIMEOUT_SECONDS = 600L;

    /** Upper bound on pool size, to catch a nonsensical value from a hand-edited profile. */
    private static final int MAX_POOL_SIZE = 32;

    /** Parses and validates a {@code connection.open} / {@code connection.test} payload. */
    public static ConnectionProfileSpec from(Map<String, Object> params) {
        String connectionId = Json.requireStr(params, "connectionId");
        String driverClassName = Json.requireStr(params, "driverClassName");
        String url = Json.requireStr(params, "url");

        return new ConnectionProfileSpec(
                connectionId,
                driverClassName,
                url.trim(),
                Json.str(params, "user"),
                Json.str(params, "password"),
                stringProperties(Json.mapValue(params, "properties")),
                clamp(Json.intValue(params, "poolSize", DEFAULT_POOL_SIZE), 1, MAX_POOL_SIZE),
                Math.max(0, Json.intValue(params, "connectTimeoutSeconds", DEFAULT_CONNECT_TIMEOUT_SECONDS)),
                Math.max(1, Json.intValue(params, "validationTimeoutSeconds", DEFAULT_VALIDATION_TIMEOUT_SECONDS)),
                Math.max(0L, Json.longValue(params, "maxLifetimeSeconds", DEFAULT_MAX_LIFETIME_SECONDS)),
                Math.max(0L, Json.longValue(params, "idleTimeoutSeconds", DEFAULT_IDLE_TIMEOUT_SECONDS)));
    }

    /**
     * Builds the {@link Properties} handed to the driver.
     *
     * <p>User, password and the explicit property bag are merged, with the property bag winning.
     * That ordering lets a user override anything, including credentials, without the extension
     * needing a dedicated field for driver-specific options.
     */
    public Properties toDriverProperties() {
        Properties result = new Properties();
        if (user != null && !user.isEmpty()) {
            result.setProperty("user", user);
        }
        if (password != null && !password.isEmpty()) {
            result.setProperty("password", password);
        }
        for (Map.Entry<String, String> entry : properties.entrySet()) {
            result.setProperty(entry.getKey(), entry.getValue());
        }
        return result;
    }

    /**
     * A log-safe rendering of this profile.
     *
     * <p>Used wherever a profile is logged or echoed into an error message. Constructing the
     * description through this method is the only sanctioned way to mention a profile in output,
     * which keeps credentials out of logs and off the wire.
     */
    public String describe() {
        return driverClassName + " -> " + url + (user == null || user.isEmpty() ? "" : " as " + user);
    }

    public ConnectionProfileSpec withConnectionId(String newConnectionId) {
        return new ConnectionProfileSpec(
                newConnectionId, driverClassName, url, user, password, properties,
                poolSize, connectTimeoutSeconds, validationTimeoutSeconds,
                maxLifetimeSeconds, idleTimeoutSeconds);
    }

    private static Map<String, String> stringProperties(Map<String, Object> source) {
        Map<String, String> result = new LinkedHashMap<>();
        for (Map.Entry<String, Object> entry : source.entrySet()) {
            Object value = entry.getValue();
            if (value != null) {
                result.put(entry.getKey(), String.valueOf(value));
            }
        }
        return result;
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }
}

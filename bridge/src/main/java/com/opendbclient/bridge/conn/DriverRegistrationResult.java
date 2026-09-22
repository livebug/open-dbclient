package com.opendbclient.bridge.conn;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import com.opendbclient.bridge.json.Json;

/**
 * Outcome of a {@code driver.register} call.
 *
 * @param jars            jars that are now on the driver classpath
 * @param drivers         driver classes that loaded successfully
 * @param failures        entries that could not be turned into a usable driver
 * @param staleDrivers    classes whose backing jar changed or vanished since the previous
 *                        registration; connections using them should be re-established
 */
public record DriverRegistrationResult(
        List<String> jars,
        List<DriverInfo> drivers,
        List<DriverFailure> failures,
        List<String> staleDrivers) {

    /**
     * A jar or class that failed to load.
     *
     * @param jar              jar involved, or {@code null} when the class name was supplied directly
     * @param driverClassName  class that failed, or {@code null} when the jar itself was unreadable
     * @param message          why it failed
     */
    public record DriverFailure(String jar, String driverClassName, String message) {
    }

    public boolean hasFailures() {
        return !failures.isEmpty();
    }

    public Map<String, Object> toPayload() {
        List<Object> driverPayloads = new ArrayList<>(drivers.size());
        for (DriverInfo driver : drivers) {
            driverPayloads.add(driver.toPayload());
        }

        List<Object> failurePayloads = new ArrayList<>(failures.size());
        for (DriverFailure failure : failures) {
            Map<String, Object> entry = Json.obj("message", failure.message());
            if (failure.jar() != null) {
                entry.put("jar", failure.jar());
            }
            if (failure.driverClassName() != null) {
                entry.put("driverClassName", failure.driverClassName());
            }
            failurePayloads.add(entry);
        }

        Map<String, Object> payload = Json.obj(
                "jarPaths", new ArrayList<Object>(jars),
                "drivers", driverPayloads,
                "failures", failurePayloads,
                "staleDrivers", new ArrayList<Object>(staleDrivers));
        // Signals that a reconnect (or a bridge restart) is needed before results can be trusted.
        payload.put("requiresReconnect", !staleDrivers.isEmpty());
        return payload;
    }
}

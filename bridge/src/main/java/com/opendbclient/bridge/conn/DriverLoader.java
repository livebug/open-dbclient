package com.opendbclient.bridge.conn;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;

import com.opendbclient.bridge.log.Log;
import com.opendbclient.bridge.rpc.Protocol;
import com.opendbclient.bridge.rpc.RpcException;

/**
 * Loads JDBC drivers supplied by the user and opens connections through them.
 *
 * <p>Two decisions here are worth stating explicitly, because the obvious alternatives are
 * both broken in practice.
 *
 * <h2>1. Driver discovery reads the service file instead of using {@code ServiceLoader}</h2>
 *
 * {@code ServiceLoader<Driver>} instantiates every advertised driver, which triggers static
 * initialisers. Many drivers register themselves with {@code DriverManager} in a static block,
 * so scanning a folder of jars would leak driver registrations and shell out real work for
 * drivers the user never intends to use. Reading {@code META-INF/services/java.sql.Driver} as
 * plain text discovers the same class names without loading a single class.
 *
 * <h2>2. Connections are opened with {@code Driver.connect}, not {@code DriverManager}</h2>
 *
 * {@code DriverManager.getConnection} only considers drivers visible to the <em>caller's</em>
 * class loader, which means a driver loaded in a dedicated {@code URLClassLoader} is routinely
 * skipped with a misleading "no suitable driver" error. Instantiating the driver and calling
 * {@code connect} directly sidesteps the filtering and reports precisely which URL was refused.
 */
public final class DriverLoader {

    private static final String SERVICE_ENTRY = "META-INF/services/java.sql.Driver";

    /** Class loaders created so far, retained so no live connection can lose its classes. */
    private final List<URLClassLoader> createdLoaders = Collections.synchronizedList(new ArrayList<>());

    private final Object lock = new Object();

    private volatile List<Path> jarPaths = List.of();
    private volatile List<String> explicitClassNames = List.of();
    private volatile ClassLoader classLoader = DriverLoader.class.getClassLoader();
    private Map<String, Driver> drivers = Map.of();
    private Map<String, DriverInfo> driverInfos = Map.of();
    private Map<String, String> jarOfDriverClass = Map.of();

    /**
     * Replaces the driver classpath and reloads drivers.
     *
     * <p>Called with the complete set every time rather than incrementally, which keeps the
     * bridge stateless about the driver folder: the extension owns discovery and simply reports
     * what it found.
     *
     * @param jars               jar files to put on the driver classpath
     * @param explicitClassNames driver classes to load even if a jar does not advertise them
     */
    public DriverRegistrationResult register(List<Path> jars, List<String> explicitClassNames) {
        List<Path> normalizedJars = normalize(jars);
        List<String> normalizedClasses = normalizeClassNames(explicitClassNames);

        synchronized (lock) {
            boolean unchanged = normalizedJars.equals(jarPaths)
                    && normalizedClasses.equals(this.explicitClassNames);
            if (unchanged) {
                Log.trace("driver classpath unchanged (%d jars, %d drivers)", jarPaths.size(), drivers.size());
                return new DriverRegistrationResult(
                        jarPaths.stream().map(Path::toString).toList(),
                        List.copyOf(driverInfos.values()),
                        List.of(),
                        List.of());
            }
        }

        Log.info("loading drivers from %d jar(s) with %d explicit class name(s)",
                normalizedJars.size(), normalizedClasses.size());

        ClassLoader loader = buildClassLoader(normalizedJars);
        List<DriverRegistrationResult.DriverFailure> failures = new ArrayList<>();
        Map<String, Driver> loadedDrivers = new LinkedHashMap<>();
        Map<String, DriverInfo> loadedInfos = new LinkedHashMap<>();
        Map<String, String> jarOfClass = new LinkedHashMap<>();

        // Advertised classes first, then explicit names, so a jar's own metadata takes
        // precedence when the same class appears in both.
        Map<String, String> candidates = new LinkedHashMap<>();
        for (Path jar : normalizedJars) {
            for (String className : readAdvertisedDrivers(jar, failures)) {
                candidates.putIfAbsent(className, jar.toString());
            }
        }
        for (String className : normalizedClasses) {
            candidates.putIfAbsent(className, null);
            jarOfClass.putIfAbsent(className, null);
        }

        for (Map.Entry<String, String> candidate : candidates.entrySet()) {
            String className = candidate.getKey();
            String sourceJar = candidate.getValue();
            try {
                Driver driver = instantiate(className, loader);
                loadedDrivers.put(className, driver);
                loadedInfos.put(className, describe(className, sourceJar, driver));
                jarOfClass.put(className, sourceJar);
            } catch (Throwable failure) {
                failures.add(new DriverRegistrationResult.DriverFailure(
                        sourceJar, className, explain(failure)));
            }
        }

        synchronized (lock) {
            List<String> stale = findStaleDrivers(this.jarOfDriverClass, jarOfClass);
            jarPaths = normalizedJars;
            this.explicitClassNames = normalizedClasses;
            classLoader = loader;
            drivers = loadedDrivers;
            driverInfos = loadedInfos;
            jarOfDriverClass = jarOfClass;

            if (!stale.isEmpty()) {
                Log.warn("driver backing jars changed for: %s", String.join(", ", stale));
            }

            return new DriverRegistrationResult(
                    normalizedJars.stream().map(Path::toString).toList(),
                    List.copyOf(loadedInfos.values()),
                    List.copyOf(failures),
                    stale);
        }
    }

    /** Drivers currently available, in registration order. */
    public List<DriverInfo> drivers() {
        return List.copyOf(driverInfos.values());
    }

    /** Jars currently on the driver classpath, in load order. */
    public List<Path> jarPaths() {
        return jarPaths;
    }

    public DriverInfo find(String driverClassName) {
        return driverInfos.get(driverClassName);
    }

    /** Throws a structured error when the requested driver is not loaded. */
    public void require(String driverClassName) {
        if (!drivers.containsKey(driverClassName)) {
            String known = drivers.isEmpty()
                    ? "no drivers are loaded; add a JDBC driver jar first"
                    : "loaded drivers: " + String.join(", ", drivers.keySet());
            throw new RpcException(Protocol.ERROR_DRIVER_NOT_FOUND,
                    "JDBC driver '" + driverClassName + "' is not loaded (" + known + ")");
        }
    }

    /**
     * Opens a physical connection using the driver named in the profile.
     *
     * @throws RpcException     when the driver is not loaded
     * @throws SQLException     when the database refuses the connection
     */
    public Connection open(ConnectionProfileSpec spec) throws SQLException {
        Driver driver;
        ClassLoader loader;
        synchronized (lock) {
            driver = drivers.get(spec.driverClassName());
            loader = classLoader;
        }
        if (driver == null) {
            require(spec.driverClassName());
            throw new RpcException(Protocol.ERROR_DRIVER_NOT_FOUND, "driver disappeared during connect");
        }

        // The JDBC login-timeout hint is process-wide static state. That is acceptable here
        // because the bridge is a single-purpose process owned by one user; the alternative
        // would be guessing each vendor's own timeout property, which is dialect knowledge the
        // project deliberately avoids. Drivers that ignore this simply keep their default.
        if (spec.connectTimeoutSeconds() > 0) {
            DriverManager.setLoginTimeout(spec.connectTimeoutSeconds());
        }

        Properties properties = spec.toDriverProperties();
        return withContextClassLoader(loader, () -> {
            Connection connection = driver.connect(spec.url(), properties);
            if (connection == null) {
                // Per the Driver contract, null means "this driver does not understand this
                // URL" - a different problem from a rejected login, and worth saying so.
                throw new SQLException(
                        "driver " + spec.driverClassName() + " does not accept the URL '" + spec.url() + "'",
                        "08001");
            }
            return connection;
        });
    }

    /** Closes every class loader this instance created, releasing the jar file handles. */
    public void shutdown() {
        synchronized (createdLoaders) {
            for (URLClassLoader loader : createdLoaders) {
                try {
                    loader.close();
                } catch (IOException ignored) {
                    // Nothing useful to do; the process is going away.
                }
            }
            createdLoaders.clear();
        }
    }

    // ------------------------------------------------------------------
    // internals
    // ------------------------------------------------------------------

    private ClassLoader buildClassLoader(List<Path> jars) {
        if (jars.isEmpty()) {
            return DriverLoader.class.getClassLoader();
        }
        List<URL> urls = new ArrayList<>(jars.size());
        for (Path jar : jars) {
            try {
                urls.add(jar.toUri().toURL());
            } catch (IOException failure) {
                Log.warn("skipping unreadable driver jar %s: %s", jar, failure.getMessage());
            }
        }
        // Parent is the bridge's own loader. The bridge bundles no third-party libraries, so a
        // driver cannot accidentally pick up a conflicting copy of anything from us.
        URLClassLoader loader = new URLClassLoader(
                urls.toArray(URL[]::new), DriverLoader.class.getClassLoader());
        createdLoaders.add(loader);
        return loader;
    }

    /**
     * Reads the driver class names a jar advertises, without loading any of them.
     *
     * Failures are recorded rather than thrown: one unreadable jar should not prevent the other
     * jars in the folder from loading.
     */
    private static List<String> readAdvertisedDrivers(
            Path jar, List<DriverRegistrationResult.DriverFailure> failures) {
        List<String> classNames = new ArrayList<>();
        try (JarFile archive = new JarFile(jar.toFile())) {
            JarEntry entry = archive.getJarEntry(SERVICE_ENTRY);
            if (entry == null) {
                Log.debug("%s does not advertise any JDBC driver", jar.getFileName());
                return classNames;
            }
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(archive.getInputStream(entry), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    String candidate = stripComment(line);
                    if (!candidate.isEmpty()) {
                        classNames.add(candidate);
                    }
                }
            }
        } catch (IOException failure) {
            failures.add(new DriverRegistrationResult.DriverFailure(
                    jar.toString(), null, "cannot read jar: " + failure.getMessage()));
        }
        return classNames;
    }

    /** Removes a trailing {@code #} comment and surrounding whitespace from a service entry. */
    private static String stripComment(String line) {
        int comment = line.indexOf('#');
        String body = comment >= 0 ? line.substring(0, comment) : line;
        return body.trim();
    }

    private static Driver instantiate(String className, ClassLoader loader) throws Exception {
        Class<?> type = Class.forName(className, true, loader);
        if (!Driver.class.isAssignableFrom(type)) {
            throw new IllegalStateException(className + " does not implement java.sql.Driver");
        }
        return (Driver) type.getDeclaredConstructor().newInstance();
    }

    private static DriverInfo describe(String className, String sourceJar, Driver driver) {
        int major = 0;
        int minor = 0;
        boolean compliant = false;
        try {
            major = driver.getMajorVersion();
            minor = driver.getMinorVersion();
            compliant = driver.jdbcCompliant();
        } catch (Throwable failure) {
            Log.debug("driver %s did not report its version: %s", className, failure);
        }
        String version = (major == 0 && minor == 0) ? null : major + "." + minor;
        return new DriverInfo(className, sourceJar, version, major, minor, compliant);
    }

    /**
     * Converts a loading failure into something a user can act on.
     *
     * {@link NoClassDefFoundError} and {@link ClassNotFoundException} are the common case and
     * almost always mean the jar is missing a dependency, which is worth saying outright
     * because the raw error names an unrelated class and confuses people.
     */
    private static String explain(Throwable failure) {
        if (failure instanceof NoClassDefFoundError || failure instanceof ClassNotFoundException) {
            return failure.getClass().getSimpleName() + ": " + failure.getMessage()
                    + " (the driver jar is likely missing a dependency it needs)";
        }
        String message = failure.getMessage();
        return message == null || message.isBlank()
                ? failure.getClass().getName()
                : failure.getClass().getSimpleName() + ": " + message;
    }

    private static List<String> findStaleDrivers(
            Map<String, String> before, Map<String, String> after) {
        if (before.isEmpty()) {
            return List.of();
        }
        List<String> stale = new ArrayList<>();
        for (Map.Entry<String, String> entry : before.entrySet()) {
            String previousJar = entry.getValue();
            String currentJar = after.get(entry.getKey());
            boolean removed = !after.containsKey(entry.getKey());
            boolean relocated = currentJar != null && !currentJar.equals(previousJar);
            if (removed || relocated) {
                stale.add(entry.getKey());
            }
        }
        return stale;
    }

    private static List<Path> normalize(List<Path> jars) {
        Set<Path> unique = new LinkedHashSet<>();
        for (Path jar : jars) {
            if (jar == null) {
                continue;
            }
            Path absolute = jar.toAbsolutePath().normalize();
            if (Files.isRegularFile(absolute)) {
                unique.add(absolute);
            } else {
                Log.warn("ignoring driver path that is not a file: %s", absolute);
            }
        }
        List<Path> result = new ArrayList<>(unique);
        Collections.sort(result);
        return List.copyOf(result);
    }

    private static List<String> normalizeClassNames(List<String> classNames) {
        Set<String> unique = new LinkedHashSet<>();
        for (String className : classNames) {
            if (className != null && !className.isBlank()) {
                unique.add(className.trim());
            }
        }
        return List.copyOf(unique);
    }

    /**
     * Runs {@code action} with the driver class loader installed as the thread context loader.
     *
     * Drivers routinely use the context loader to find their own resources - service files,
     * bundled keystores, logging bindings - and without this they fail with confusing
     * "resource not found" errors despite being loaded correctly.
     */
    private static <T> T withContextClassLoader(ClassLoader loader, MetadataSupport.SqlCall<T> action)
            throws SQLException {
        Thread thread = Thread.currentThread();
        ClassLoader previous = thread.getContextClassLoader();
        thread.setContextClassLoader(loader);
        try {
            return action.get();
        } finally {
            thread.setContextClassLoader(previous);
        }
    }
}

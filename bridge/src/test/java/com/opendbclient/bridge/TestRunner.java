package com.opendbclient.bridge;

import java.util.ArrayList;
import java.util.List;

/**
 * Minimal test harness.
 *
 * <p>The bridge has no third-party dependencies, so there is no JUnit on the classpath. This
 * covers what the project actually needs: named cases, a pass/fail summary, and a non-zero
 * exit code so CI fails properly.
 */
public final class TestRunner {

    /**
     * A test case body.
     *
     * <p>Declares {@code throws Exception} so cases that drive pipes or sockets can be written
     * as plain method references instead of wrapping everything in try/catch.
     */
    @FunctionalInterface
    public interface Case {
        void execute() throws Exception;
    }

    private final List<String> names = new ArrayList<>();
    private final List<Case> bodies = new ArrayList<>();

    public void test(String name, Case body) {
        names.add(name);
        bodies.add(body);
    }

    /** Runs every registered case and returns the process exit code. */
    public int runAll() {
        List<String> failures = new ArrayList<>();
        for (int i = 0; i < names.size(); i++) {
            String name = names.get(i);
            try {
                bodies.get(i).execute();
                System.out.println("  PASS  " + name);
            } catch (Throwable failure) {
                failures.add(name);
                System.out.println("  FAIL  " + name);
                System.out.println("        " + failure);
                if (!(failure instanceof AssertionError)) {
                    failure.printStackTrace(System.out);
                }
            }
        }

        System.out.println();
        System.out.printf("%d passed, %d failed, %d total%n",
                names.size() - failures.size(), failures.size(), names.size());
        if (!failures.isEmpty()) {
            System.out.println();
            System.out.println("Failed cases:");
            for (String failure : failures) {
                System.out.println("  - " + failure);
            }
        }
        return failures.isEmpty() ? 0 : 1;
    }
}

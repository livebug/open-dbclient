package com.opendbclient.bridge;

import java.util.Objects;

/** Assertion helpers used by the bridge test suite. */
public final class Assert {

    private Assert() {
    }

    public static void that(boolean condition, String message) {
        if (!condition) {
            throw new AssertionError(message);
        }
    }

    public static void equal(Object expected, Object actual, String what) {
        if (!Objects.equals(expected, actual)) {
            throw new AssertionError(what + "\n        expected: <" + expected + ">\n        actual:   <" + actual + ">");
        }
    }

    public static void notNull(Object value, String what) {
        if (value == null) {
            throw new AssertionError(what + ": expected a non-null value");
        }
    }

    public static void isNull(Object value, String what) {
        if (value != null) {
            throw new AssertionError(what + ": expected null but was <" + value + ">");
        }
    }

    public static void fail(String message) {
        throw new AssertionError(message);
    }

    /** Asserts that running {@code body} throws an instance of {@code expected}. */
    public static void throwsError(Class<? extends Throwable> expected, Runnable body, String what) {
        try {
            body.run();
        } catch (Throwable actual) {
            if (expected.isInstance(actual)) {
                return;
            }
            throw new AssertionError(what + ": expected " + expected.getSimpleName()
                    + " but got " + actual.getClass().getSimpleName() + " (" + actual.getMessage() + ")");
        }
        throw new AssertionError(what + ": expected " + expected.getSimpleName()
                + " to be thrown, but nothing was thrown");
    }
}

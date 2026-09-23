package com.opendbclient.bridge;

import com.opendbclient.bridge.json.JsonTests;
import com.opendbclient.bridge.metadata.DdlOptionsTests;
import com.opendbclient.bridge.rpc.ProtocolTests;

/** Entry point for `node scripts/build-bridge.mjs --test`. */
public final class BridgeTests {

    private BridgeTests() {
    }

    public static void main(String[] args) {
        TestRunner runner = new TestRunner();
        System.out.println("JSON");
        JsonTests.register(runner);
        System.out.println("RPC protocol");
        ProtocolTests.register(runner);
        System.out.println("DDL options");
        DdlOptionsTests.register(runner);

        System.out.println();
        System.exit(runner.runAll());
    }
}

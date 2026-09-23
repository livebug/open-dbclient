#!/usr/bin/env node
/**
 * End-to-end smoke test against a real JDBC driver.
 *
 * Unlike the unit tests in `bridge/src/test`, this drives the built jar over its actual protocol
 * with a real driver on the classpath, so it covers the parts that only exist in the assembled
 * product: jar scanning, class loading in a dedicated loader, real connection establishment and
 * pool accounting.
 *
 * The driver is intentionally not vendored. Point the script at a directory of jars:
 *
 *   node scripts/smoke-test.mjs /path/to/driver-dir
 *   OPEN_DBCLIENT_DRIVER_DIR=/path/to/driver-dir npm run smoke
 *
 * SQLite works well because it needs no server. To fetch it:
 *
 *   mkdir -p /tmp/dbclient-drivers && cd /tmp/dbclient-drivers
 *   curl -O https://repo1.maven.org/maven2/org/xerial/sqlite-jdbc/3.47.1.0/sqlite-jdbc-3.47.1.0.jar
 *   curl -O https://repo1.maven.org/maven2/org/slf4j/slf4j-api/2.0.16/slf4j-api-2.0.16.jar
 *
 * When no driver directory is supplied the script explains what it needs and exits successfully,
 * so it can sit in a build pipeline without failing on machines that have no driver available.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const bridgeJar = join(root, 'resources', 'bridge.jar');

const driverDir = resolve(process.argv[2] ?? process.env.OPEN_DBCLIENT_DRIVER_DIR ?? '');

const failures = [];
let checks = 0;

function check(condition, label, detail) {
  checks++;
  const shown = detail === undefined ? '' : ` -> ${detail}`;
  if (condition) {
    console.log(`  PASS  ${label}${shown}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}${shown}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/**
 * Drives the bridge synchronously: one request written, its response awaited.
 *
 * This mirrors how the extension behaves. Sending frames in a batch would race, because the
 * bridge dispatches concurrently so that cancellation stays reachable during a long query.
 */
class Bridge {
  constructor() {
    this.child = spawn('java', ['-jar', bridgeJar], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map();
    this.events = [];
    this.corruptFrames = [];
    this.stderrChunks = [];
    this.counter = 0;

    createInterface({ input: this.child.stdout }).on('line', (line) => this.onLine(line));
    this.child.stderr.on('data', (chunk) => this.stderrChunks.push(chunk.toString()));

    this.exited = new Promise((resolveExit) => this.child.on('exit', resolveExit));
  }

  onLine(line) {
    if (!line.trim()) {
      return;
    }
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      // Any unparseable line means something wrote to stdout outside the protocol, which in a
      // JDBC bridge usually means a driver printing a banner. Worth failing on.
      this.corruptFrames.push(line);
      return;
    }
    if (frame.type === 'event') {
      this.events.push(frame.method);
      return;
    }
    const resolver = this.pending.get(frame.id);
    if (resolver) {
      this.pending.delete(frame.id);
      resolver(frame);
    }
  }

  request(method, params) {
    const id = String(++this.counter);
    return new Promise((resolveFrame) => {
      this.pending.set(id, resolveFrame);
      this.child.stdin.write(`${JSON.stringify({ id, method, params: params ?? {} })}\n`);
    });
  }

  async call(method, params) {
    const frame = await this.request(method, params);
    return frame.ok ? { result: frame.result, error: null } : { result: null, error: frame.error };
  }

  stderr() {
    return this.stderrChunks.join('');
  }

  async shutdown() {
    await this.call('system.shutdown');
    this.child.stdin.end();
    const code = await Promise.race([
      this.exited,
      new Promise((resolveTimeout) => setTimeout(() => resolveTimeout('timeout'), 10_000)),
    ]);
    if (code === 'timeout') {
      this.child.kill();
    }
    return code;
  }
}

function listJars(dir) {
  if (!dir || !existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.jar'))
    .map((name) => join(dir, name))
    .filter((full) => statSync(full).isFile())
    .sort();
}

/**
 * Creates a SQLite file whose schema is shaped to catch a specific class of bug.
 *
 * `user_account` and `userXaccount` differ only in the character standing where an underscore
 * sits. Metadata lookups pass table names to JDBC as LIKE patterns, so without escaping, asking
 * for the columns of `user_account` also matches `userXaccount`. Real schemas are full of
 * underscores, which makes this the most likely way for name handling to go quietly wrong.
 *
 * Returns null when the runtime has no built-in SQLite, so the caller can skip cleanly.
 */
async function createFixtureDatabase() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return null;
  }

  const dbPath = join(tmpdir(), `open-dbclient-fixture-${process.pid}.db`);
  rmSync(dbPath, { force: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE user_account (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      balance NUMERIC(10,2)
    );
    CREATE INDEX idx_user_account_email ON user_account (email);
    CREATE TABLE userXaccount (
      id INTEGER PRIMARY KEY,
      unrelated TEXT
    );
  `);
  db.close();
  return dbPath;
}

async function main() {
  if (!existsSync(bridgeJar)) {
    console.error(`\n[smoke] ${bridgeJar} is missing. Run: npm run bridge:compile\n`);
    process.exit(1);
  }

  const jars = listJars(driverDir);
  if (jars.length === 0) {
    console.log(
      '\n[smoke] No JDBC driver jars found, so the end-to-end checks were skipped.\n' +
        '[smoke] Supply a directory containing at least one driver jar:\n' +
        '[smoke]   node scripts/smoke-test.mjs /path/to/driver-dir\n' +
        '[smoke]   OPEN_DBCLIENT_DRIVER_DIR=/path/to/driver-dir npm run smoke\n' +
        '\n[smoke] SQLite needs no server and works well for this:\n' +
        '[smoke]   curl -O https://repo1.maven.org/maven2/org/xerial/sqlite-jdbc/3.47.1.0/sqlite-jdbc-3.47.1.0.jar\n',
    );
    return;
  }

  console.log(`[smoke] using ${jars.length} driver jar(s) from ${driverDir}`);
  const bridge = new Bridge();

  try {
    section('[1] handshake');
    await new Promise((resolveReady) => setTimeout(resolveReady, 300));
    check(bridge.events.includes('bridge.ready'), 'bridge announces itself', bridge.events.join(', '));

    section('[2] driver registration');
    const registration = await bridge.call('driver.register', { jarPaths: jars });
    check(registration.error === null, 'driver.register succeeds', registration.error?.message);
    const drivers = registration.result?.drivers ?? [];
    check(drivers.length > 0, 'at least one driver was discovered', drivers.length);
    check(
      registration.result?.failures?.length === 0,
      'no driver failed to load',
      JSON.stringify(registration.result?.failures),
    );
    for (const driver of drivers) {
      console.log(`        ${driver.driverClassName}  (${driver.displayName})  ${driver.sourceJar ?? ''}`);
    }

    const first = drivers[0];
    if (!first) {
      throw new Error('no driver available to connect with');
    }

    // Derive a URL that the discovered driver will accept. SQLite is the case this script is
    // documented for; anything else is reported rather than guessed at.
    if (!first.driverClassName.includes('sqlite')) {
      console.log(
        `\n[smoke] The discovered driver (${first.driverClassName}) is not SQLite, and this script\n` +
          '[smoke] does not know how to reach that database. Driver loading was verified; stopping here.\n',
      );
      return;
    }

    const connectionParams = {
      driverClassName: first.driverClassName,
      url: 'jdbc:sqlite::memory:',
    };

    section('[3] connection.test leaves nothing behind');
    const test = await bridge.call('connection.test', connectionParams);
    check(test.error === null, 'connection.test succeeds', test.error?.message);
    const capabilities = test.result?.capabilities ?? {};
    check(capabilities.databaseProductName === 'SQLite', 'database identity reported', capabilities.databaseProductName);
    check('identifierQuoteString' in capabilities, 'identifier quoting probed', capabilities.identifierQuoteString);
    check('supportsTransactions' in capabilities, 'capability flags probed', capabilities.supportsTransactions);
    console.log(`        ${capabilities.description}`);

    section('[4] connection.open establishes a pool');
    const open = await bridge.call('connection.open', {
      ...connectionParams,
      connectionId: 'smoke',
      poolSize: 2,
    });
    check(open.error === null, 'connection.open succeeds', open.error?.message);
    check(typeof open.result?.connectMillis === 'number', 'connect timing reported', open.result?.connectMillis);

    section('[5] pool accounting');
    const listing = await bridge.call('connection.list');
    const pool = listing.result?.connections?.[0]?.pool;
    check(listing.error === null, 'connection.list succeeds', listing.error?.message);
    check(pool?.maxSize === 2, 'pool size honoured', pool?.maxSize);
    check(pool?.total === 1, 'exactly one physical connection created', pool?.total);
    check(pool?.active === 0, 'the connection was returned to the pool', pool?.active);
    check(pool?.idle === 1, 'it is parked as idle', pool?.idle);
    check(pool?.borrowTimeouts === 0, 'no borrow timed out', pool?.borrowTimeouts);

    section('[6] reopening the same profile reuses the pool');
    const reopen = await bridge.call('connection.open', { ...connectionParams, connectionId: 'smoke', poolSize: 2 });
    check(reopen.error === null, 'reopen succeeds', reopen.error?.message);
    check(reopen.result?.connectMillis === 0, 'reopen skipped connecting', reopen.result?.connectMillis);
    const afterReopen = await bridge.call('connection.list');
    check(
      afterReopen.result?.connections?.[0]?.pool?.created === 1,
      'no second physical connection was created',
      afterReopen.result?.connections?.[0]?.pool?.created,
    );

    section('[7] credentials change forces a fresh pool');
    const withUser = await bridge.call('connection.open', {
      ...connectionParams,
      connectionId: 'smoke',
      user: 'someone-else',
      poolSize: 2,
    });
    check(withUser.error === null, 'reopen with new credentials succeeds', withUser.error?.message);
    const afterUser = await bridge.call('connection.list');
    check(
      afterUser.result?.connections?.[0]?.pool?.created === 1,
      'the previous pool was replaced rather than reused',
      afterUser.result?.connections?.[0]?.pool?.created,
    );

    section('[8] error classification');
    const unknownDriver = await bridge.call('connection.open', {
      connectionId: 'nope',
      driverClassName: 'com.example.NotLoaded',
      url: 'jdbc:example://host',
    });
    check(
      unknownDriver.error?.code === 'DRIVER_NOT_FOUND',
      'an unloaded driver reports DRIVER_NOT_FOUND',
      unknownDriver.error?.code,
    );

    const wrongUrl = await bridge.call('connection.open', {
      connectionId: 'nope',
      driverClassName: first.driverClassName,
      url: 'jdbc:somethingelse://host',
    });
    check(wrongUrl.error?.code === 'SQL_ERROR', 'a refused URL reports SQL_ERROR', wrongUrl.error?.code);
    check(
      wrongUrl.error?.message?.includes('does not accept the URL'),
      'the refusal explains which URL was rejected',
      wrongUrl.error?.message,
    );

    const missingParams = await bridge.call('connection.open', { connectionId: 'incomplete' });
    check(
      missingParams.error?.code === 'INVALID_PARAMS',
      'a missing parameter reports INVALID_PARAMS rather than looking like a bridge defect',
      missingParams.error?.code,
    );

    section('[9] connection.close tears the pool down');
    const closed = await bridge.call('connection.close', { connectionId: 'smoke' });
    check(closed.result?.closed === true, 'close reports success', JSON.stringify(closed.result));
    const afterClose = await bridge.call('connection.list');
    check(afterClose.result?.count === 0, 'no connections remain', afterClose.result?.count);

    section('[10] schema introspection');
    const fixturePath = await createFixtureDatabase();
    if (!fixturePath) {
      console.log('        skipped: this runtime has no built-in node:sqlite');
    } else {
      const fixtureUrl = `jdbc:sqlite:${fixturePath}`;
      const fixtureOpen = await bridge.call('connection.open', {
        connectionId: 'fixture',
        driverClassName: first.driverClassName,
        url: fixtureUrl,
      });
      check(fixtureOpen.error === null, 'opened the fixture database', fixtureOpen.error?.message);

      const types = await bridge.call('metadata.tableTypes', { connectionId: 'fixture' });
      check(
        types.result?.tableTypes?.includes('TABLE'),
        'the driver reports the table type labels it uses',
        (types.result?.tableTypes ?? []).join(', '),
      );

      const tables = await bridge.call('metadata.tables', { connectionId: 'fixture' });
      const tableNames = (tables.result?.tables ?? []).map((t) => t.name).sort();
      check(
        tableNames.includes('user_account') && tableNames.includes('userXaccount'),
        'both fixture tables are listed',
        tableNames.join(', '),
      );

      const columns = await bridge.call('metadata.columns', { connectionId: 'fixture', table: 'user_account' });
      const columnNames = (columns.result?.columns ?? []).map((c) => c.name);
      check(columnNames.length === 4, 'exactly the columns of user_account', columnNames.join(', '));
      check(
        !columnNames.includes('unrelated'),
        'underscores were escaped, so userXaccount did not satisfy the user_account lookup',
        columnNames.join(', '),
      );

      const idColumn = (columns.result?.columns ?? []).find((c) => c.name === 'id');
      check(idColumn?.primaryKey === true, 'primary key membership detected', idColumn?.primaryKey);
      const emailColumn = (columns.result?.columns ?? []).find((c) => c.name === 'email');
      check(emailColumn?.nullable === false, 'NOT NULL detected', emailColumn?.nullable);
      check(
        typeof emailColumn?.jdbcTypeName === 'string' && emailColumn.jdbcTypeName.length > 0,
        'JDBC type constant mapped to a readable name',
        emailColumn?.jdbcTypeName,
      );

      const indexes = await bridge.call('metadata.indexes', { connectionId: 'fixture', table: 'user_account' });
      const indexNames = (indexes.result?.indexes ?? []).map((i) => i.name);
      check(indexNames.includes('idx_user_account_email'), 'index listed', indexNames.join(', '));

      const ddlResult = await bridge.call('metadata.ddl', { connectionId: 'fixture', table: 'user_account' });
      const ddl = ddlResult.result?.ddl ?? '';
      check(ddlResult.error === null, 'DDL generated', ddlResult.error?.message);
      check(ddl.startsWith('CREATE TABLE'), 'DDL begins with a CREATE TABLE statement', ddl.split('\n')[0]);
      check(
        ['id', 'email', 'created_at', 'balance'].every((name) => ddl.includes(name)),
        'every column appears in the DDL',
      );
      check(ddl.includes('PRIMARY KEY'), 'primary key clause present');
      check(ddl.includes('NOT NULL'), 'nullability present');
      check(ddl.includes('idx_user_account_email'), 'index emitted alongside the table');

      // The presentation options travel with the request, so this is the check that the extension
      // and the bridge agree on the wire format rather than only inside their own tests.
      const custom = await bridge.call('metadata.ddl', {
        connectionId: 'fixture',
        table: 'user_account',
        options: { ifNotExists: true, indent: '\t', includeIndexes: false, quoteIdentifiers: false },
      });
      const customDdl = custom.result?.ddl ?? '';
      check(custom.error === null, 'DDL generated with options', custom.error?.message);
      check(
        customDdl.startsWith('CREATE TABLE IF NOT EXISTS user_account'),
        'IF NOT EXISTS and unquoted identifiers are applied',
        customDdl.split('\n')[0],
      );
      check(customDdl.includes('\n\tid'), 'the custom indent is applied');
      check(
        !customDdl.includes('CREATE INDEX'),
        'the index section is omitted when asked',
        customDdl.split('\n').filter((line) => line.includes('INDEX')).join(' '),
      );
      check(
        !customDdl.includes('"'),
        'no identifier is quoted when quoting is off',
      );

      // An option the extension should never send must not cost the user their DDL.
      const junk = await bridge.call('metadata.ddl', {
        connectionId: 'fixture',
        table: 'user_account',
        options: { ifNotExists: 'yes', indent: 'x'.repeat(200) },
      });
      check(junk.error === null, 'unusable options fall back instead of failing', junk.error?.message);
      check(
        (junk.result?.ddl ?? '').startsWith('CREATE TABLE "user_account"'),
        'the fallback is the default formatting',
        (junk.result?.ddl ?? '').split('\n')[0],
      );

      console.log(ddl.split('\n').map((line) => `        ${line}`).join('\n'));

      // Left open on purpose: shutdown has to cope with a live connection.
      check(fixturePath.length > 0, 'fixture database created', fixturePath);
    }

    section('[11] query execution');
    if (!fixturePath) {
      console.log('        skipped: no fixture database');
    } else {
      const fixture = { connectionId: 'fixture' };

      const create = await bridge.call('query.execute', {
        ...fixture,
        sql: `CREATE TABLE numbers (
                id INTEGER PRIMARY KEY,
                huge INTEGER,
                amount NUMERIC(20,4),
                label TEXT,
                note TEXT
              )`,
      });
      check(create.error === null, 'DDL executes', create.error?.message);
      check(create.result?.hasResultSet === false, 'DDL reports no result set', create.result?.hasResultSet);

      const insert = await bridge.call('query.execute', {
        ...fixture,
        sql: `INSERT INTO numbers VALUES
                (1, 9007199254740993, 12345.6789, 'héllo 世界 😀', NULL),
                (2, -42, 0.5, 'plain', 'kept')`,
      });
      check(insert.error === null, 'INSERT executes', insert.error?.message);
      check(insert.result?.updateCount === 2, 'INSERT reports two affected rows', insert.result?.updateCount);

      const select = await bridge.call('query.execute', {
        ...fixture,
        sql: 'SELECT * FROM numbers ORDER BY id',
      });
      check(select.error === null, 'SELECT executes', select.error?.message);
      check(select.result?.hasResultSet === true, 'SELECT reports a result set');
      check(select.result?.totalRows === 2, 'both rows were read', select.result?.totalRows);
      check(select.result?.columns?.length === 5, 'five columns described', select.result?.columns?.length);
      check(select.result?.elapsedMillis >= 0, 'execution time reported', select.result?.elapsedMillis);

      const first = select.result?.rows?.[0] ?? [];
      const second = select.result?.rows?.[1] ?? [];
      console.log(`        row 1: ${JSON.stringify(first)}`);
      console.log(`        row 2: ${JSON.stringify(second)}`);

      // The whole reason numbers are not all sent as JSON numbers.
      check(
        first[1] === '9007199254740993',
        'an integer beyond 2^53 is sent as a string rather than silently rounded',
        JSON.stringify(first[1]),
      );
      check(first[3] === 'héllo 世界 😀', 'non-ASCII text and astral characters survive the protocol', first[3]);
      check(first[4] === null, 'NULL is preserved as null rather than as text', JSON.stringify(first[4]));
      check(typeof first[0] === 'number', 'a small integer stays numeric', typeof first[0]);
      check(second[4] === 'kept', 'plain text round-trips', second[4]);

      const columns = select.result?.columns ?? [];
      const amountColumn = columns.find((column) => column.name === 'amount');
      check(typeof amountColumn?.displayType === 'string' && amountColumn.displayType.length > 0,
        'result columns carry a rendered type', amountColumn?.displayType);

      // Nullability is asserted as a contract rather than a value. ResultSetMetaData.isNullable is
      // allowed to answer "unknown", and SQLite's driver does exactly that, so the guarantee worth
      // testing is that the bridge stays a boolean and never claims NOT NULL on the strength of a
      // driver that said nothing. The NOT NULL path itself is covered by the table-metadata checks
      // in section 10, where the driver does report it.
      const idColumn = columns.find((column) => column.name === 'id');
      check(typeof idColumn?.nullable === 'boolean',
        'result column nullability is reported as a boolean', idColumn?.nullable);
      check(columns.every((column) => typeof column.nullable === 'boolean'),
        'every result column reports nullability');

      section('[12] paging and truncation');
      const page = await bridge.call('query.fetch', { queryId: select.result.queryId, offset: 1, limit: 1 });
      check(page.error === null, 'query.fetch succeeds', page.error?.message);
      check(page.result?.rows?.length === 1, 'exactly one row returned', page.result?.rows?.length);
      check(page.result?.rows?.[0]?.[0] === 2, 'the second row was returned', JSON.stringify(page.result?.rows?.[0]?.[0]));
      check(page.result?.totalRows === 2, 'total row count is still known', page.result?.totalRows);

      const beyondEnd = await bridge.call('query.fetch', { queryId: select.result.queryId, offset: 99, limit: 10 });
      check(beyondEnd.result?.rows?.length === 0, 'paging past the end returns nothing rather than failing');

      const truncatedRun = await bridge.call('query.execute', {
        ...fixture,
        sql: 'SELECT * FROM numbers ORDER BY id',
        maxRows: 1,
      });
      check(truncatedRun.result?.truncated === true, 'a maxRows ceiling is reported', truncatedRun.result?.truncated);
      check(truncatedRun.result?.truncatedAt === 1, 'the ceiling is echoed back', truncatedRun.result?.truncatedAt);
      check(truncatedRun.result?.totalRows === 1, 'only the permitted number of rows was stored', truncatedRun.result?.totalRows);

      section('[13] query lifetime and errors');
      await bridge.call('query.close', { queryId: truncatedRun.result.queryId });
      const afterClose = await bridge.call('query.fetch', { queryId: truncatedRun.result.queryId, offset: 0, limit: 5 });
      check(afterClose.error?.code === 'QUERY_NOT_FOUND', 'a released result is reported as gone', afterClose.error?.code);

      const cancelUnknown = await bridge.call('query.cancel', { queryId: 'no-such-query' });
      check(cancelUnknown.error?.code === 'QUERY_NOT_FOUND', 'cancelling an unknown query is reported', cancelUnknown.error?.code);

      const badSql = await bridge.call('query.execute', { ...fixture, sql: 'SELECT * FROM no_such_table_here' });
      check(badSql.error?.code === 'SQL_ERROR', 'a SQL failure is classified as SQL_ERROR', badSql.error?.code);
      check(typeof badSql.error?.message === 'string' && badSql.error.message.length > 0,
        'the database explains the failure', badSql.error?.message);

      section('[14] health metrics');
      const snapshot = await bridge.call('health.snapshot');
      check(snapshot.error === null, 'health.snapshot succeeds', snapshot.error?.message);
      check(typeof snapshot.result?.memory?.heapUsed === 'number', 'heap usage is reported', snapshot.result?.memory?.heapUsed);
      check(snapshot.result?.memory?.heapMax > 0, 'heap ceiling is reported', snapshot.result?.memory?.heapMax);
      check(typeof snapshot.result?.memory?.heapUsedPercent === 'number', 'heap usage is a percentage');
      check(snapshot.result?.memory?.metaspaceUsed >= 0, 'metaspace is reported', snapshot.result?.memory?.metaspaceUsed);
      check(Array.isArray(snapshot.result?.garbageCollector?.collectors), 'garbage collectors are enumerated');
      check(typeof snapshot.result?.threads?.count === 'number', 'thread count is reported', snapshot.result?.threads?.count);
      check(Array.isArray(snapshot.result?.poolSummaries), 'pool summaries are included');
      check(typeof snapshot.result?.cache?.cachedBytes === 'number', 'result cache size is reported', snapshot.result?.cache?.cachedBytes);
      check(snapshot.result?.cache?.storedResults >= 1, 'the stored result is visible in the cache accounting',
        snapshot.result?.cache?.storedResults);
      check(typeof snapshot.result?.queries?.completed === 'number', 'query counters are reported',
        snapshot.result?.queries?.completed);
      check(typeof snapshot.result?.server?.requestsHandled === 'number', 'request counters are reported',
        snapshot.result?.server?.requestsHandled);

      const configured = await bridge.call('system.configure', { resultMaxCacheBytes: 1024 * 1024 });
      check(configured.error === null, 'system.configure applies the cache budget', configured.error?.message);
      const afterConfigure = await bridge.call('health.snapshot');
      check(afterConfigure.result?.cache?.maxCacheBytes === 1024 * 1024,
        'the cache budget took effect', afterConfigure.result?.cache?.maxCacheBytes);

      const subscribed = await bridge.call('health.subscribe', { intervalMillis: 500 });
      check(subscribed.result?.subscribed === true, 'health.subscribe is accepted', JSON.stringify(subscribed.result));
      await new Promise((resolveWait) => setTimeout(resolveWait, 900));
      const pushed = bridge.events.filter((name) => name === 'health.metrics').length;
      check(pushed >= 1, 'health metrics are pushed after subscribing', pushed);
      const unsubscribed = await bridge.call('health.unsubscribe');
      check(unsubscribed.result?.subscribed === false, 'health.unsubscribe stops the push');

      await bridge.call('connection.close', { connectionId: 'fixture' });
    }

    section('[15] export');
    const exportDir = mkdtempSync(join(tmpdir(), 'open-dbclient-export-'));
    if (!fixturePath) {
      console.log('        skipped: no fixture database');
    } else {
      const fixture = { connectionId: 'fixture' };

      // The health section closed this connection, which also released its cached results. Reopening
      // exercises that path and gives the export checks something to read from.
      const reopened = await bridge.call('connection.open', {
        connectionId: 'fixture',
        driverClassName: first.driverClassName,
        url: `jdbc:sqlite:${fixturePath}`,
      });
      check(reopened.error === null, 'the fixture connection reopens after being closed', reopened.error?.message);

      // A row whose text contains the CSV delimiter, a double quote and a single quote. Only data
      // that holds the characters being escaped can actually prove the escaping rules.
      await bridge.call('query.execute', {
        ...fixture,
        sql: `INSERT INTO numbers VALUES (3, 7, 1.5, 'has,comma "and" ''single''', 'x')`,
      });

      const selectSql = 'SELECT * FROM numbers ORDER BY id';

      const csvPath = join(exportDir, 'rows.csv');
      const csv = await bridge.call('query.export', {
        ...fixture,
        sql: selectSql,
        format: 'csv',
        filePath: csvPath,
        options: { delimiter: ',', includeHeader: true, writeBom: true },
      });
      check(csv.error === null, 'CSV export succeeds', csv.error?.message);
      check(csv.result?.rows === 3, 'CSV export reports three rows', csv.result?.rows);
      check(csv.result?.bytes > 0, 'CSV export reports its size', csv.result?.bytes);

      const csvText = csv.error ? '' : readFileSync(csvPath, 'utf8');
      check(csvText.charCodeAt(0) === 0xfeff, 'CSV starts with a BOM so Excel reads it as UTF-8');
      const csvLines = csvText.replace(/^\uFEFF/, '').split('\r\n').filter((line) => line.length > 0);
      check(csvLines.length === 4, 'CSV holds a header and three rows', csvLines.length);
      check(csvLines[0] === 'id,huge,amount,label,note', 'CSV header uses the column labels', csvLines[0]);
      check(
        csvLines[3] === `3,7,1.5,"has,comma ""and"" 'single'",x`,
        'a field holding the delimiter and a quote is wrapped and its quotes are doubled',
        csvLines[3],
      );
      check(csvLines[1].includes('héllo 世界 😀'), 'CSV carries non-ASCII text intact', csvLines[1]);

      const jsonPath = join(exportDir, 'rows.json');
      const json = await bridge.call('query.export', {
        ...fixture,
        sql: selectSql,
        format: 'json',
        filePath: jsonPath,
      });
      check(json.error === null, 'JSON export succeeds', json.error?.message);
      const parsedJson = json.error ? [] : JSON.parse(readFileSync(jsonPath, 'utf8'));
      check(Array.isArray(parsedJson) && parsedJson.length === 3, 'JSON export is an array of three objects', parsedJson.length);
      check(
        parsedJson[0].huge === '9007199254740993',
        'JSON export keeps a big integer precise rather than rounding it',
        parsedJson[0].huge,
      );
      check(parsedJson[0].note === null, 'JSON export preserves null as null', JSON.stringify(parsedJson[0].note));
      check(typeof parsedJson[0].id === 'number', 'JSON export keeps small integers numeric', typeof parsedJson[0].id);

      const insertPath = join(exportDir, 'rows.sql');
      const insert = await bridge.call('query.export', {
        ...fixture,
        sql: selectSql,
        format: 'sql',
        filePath: insertPath,
        tableName: 'numbers',
        options: { rowsPerStatement: 2 },
      });
      check(insert.error === null, 'INSERT export succeeds', insert.error?.message);
      const insertText = insert.error ? '' : readFileSync(insertPath, 'utf8');
      check(
        insertText.includes('INSERT INTO numbers (id, huge, amount, label, note) VALUES'),
        'INSERT statements name the table and every column',
      );
      check(insertText.includes(`'has,comma "and" ''single'''`),
        'single quotes are escaped by doubling while double quotes are left alone');
      check(
        insertText.includes('(1, 9007199254740993,'),
        'a numeric value kept as text is still emitted unquoted, so it stays a number',
      );
      const statementCount = (insertText.match(/;/g) ?? []).length;
      check(statementCount === 2, 'rowsPerStatement is honoured', statementCount);

      const missingTable = await bridge.call('query.export', {
        ...fixture,
        sql: selectSql,
        format: 'sql',
        filePath: join(exportDir, 'should-not-exist.sql'),
      });
      check(missingTable.error?.code === 'INVALID_PARAMS', 'INSERT export without a table name is rejected',
        missingTable.error?.code);
      check(!existsSync(join(exportDir, 'should-not-exist.sql')),
        'a rejected export leaves no partial file behind');

      const xlsxPath = join(exportDir, 'rows.xlsx');
      const xlsx = await bridge.call('query.export', {
        ...fixture,
        sql: selectSql,
        format: 'xlsx',
        filePath: xlsxPath,
      });
      check(xlsx.error === null, 'xlsx export succeeds', xlsx.error?.message);
      const xlsxBytes = xlsx.error ? Buffer.alloc(0) : readFileSync(xlsxPath);
      check(xlsxBytes[0] === 0x50 && xlsxBytes[1] === 0x4b, 'xlsx output is a ZIP archive',
        `${xlsxBytes[0]},${xlsxBytes[1]}`);
      check(xlsxBytes.length > 800, 'the workbook has content', xlsxBytes.length);

      const storedSource = await bridge.call('query.execute', { ...fixture, sql: selectSql });
      const fromStoredPath = join(exportDir, 'from-stored.csv');
      const fromStored = await bridge.call('query.export', {
        connectionId: 'fixture',
        queryId: storedSource.result.queryId,
        format: 'csv',
        filePath: fromStoredPath,
      });
      check(fromStored.error === null, 'exporting an existing result succeeds', fromStored.error?.message);
      check(fromStored.result?.rows === 3, 'all rows were exported from the stored result', fromStored.result?.rows);

      const badFormat = await bridge.call('query.export', {
        ...fixture,
        sql: selectSql,
        format: 'not-a-format',
        filePath: join(exportDir, 'x'),
      });
      check(badFormat.error?.code === 'INVALID_PARAMS', 'an unknown format is rejected clearly', badFormat.error?.code);

      rmSync(exportDir, { recursive: true, force: true });
    }

    section('[16] protocol integrity');
    check(
      bridge.corruptFrames.length === 0,
      'every line on stdout was a valid protocol frame',
      bridge.corruptFrames.join(' | '),
    );

    section('[17] shutdown');
    const code = await bridge.shutdown();
    check(code === 0, 'bridge exited cleanly', code);
  } finally {
    if (bridge.child.exitCode === null) {
      bridge.child.kill();
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} of ${checks} checks FAILED:`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }
  console.log(`\nall ${checks} end-to-end checks passed`);
}

main().catch((failure) => {
  console.error('\n[smoke] aborted:', failure);
  process.exit(1);
});

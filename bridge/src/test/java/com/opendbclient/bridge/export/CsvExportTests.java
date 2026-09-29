package com.opendbclient.bridge.export;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Types;
import java.util.ArrayList;
import java.util.List;

import com.opendbclient.bridge.Assert;
import com.opendbclient.bridge.TestRunner;
import com.opendbclient.bridge.result.ResultColumn;

/**
 * Tests for the CSV writer.
 *
 * <p>These drive real files rather than an internal method, because the interesting properties are all
 * about the bytes a reader will see: which field ends up quoted, what the separator between fields
 * looks like, and whether the BOM is there. A test against an in-memory builder would pass while the
 * file was still wrong.
 *
 * <p>The cases that matter most are the ones a single-character implementation got wrong: a separator
 * of several characters such as {@code ~@~}, and a field that contains part of it but not all of it.
 */
public final class CsvExportTests {

    private CsvExportTests() {
    }

    public static void register(TestRunner runner) {
        runner.test("a multi-character separator is written literally", CsvExportTests::multiCharacterSeparator);
        runner.test("a field containing the separator is quoted", CsvExportTests::fieldWithSeparatorIsQuoted);
        runner.test("a field containing only part of the separator is not quoted", CsvExportTests::partialSeparatorIsLeftAlone);
        runner.test("minimal quoting doubles an embedded quote", CsvExportTests::embeddedQuoteIsDoubled);
        runner.test("always quotes every field, header included", CsvExportTests::alwaysQuotesEverything);
        runner.test("never writes fields verbatim but counts them", CsvExportTests::neverQuotesAndCounts);
        runner.test("nothing is counted when no field needed quotes", CsvExportTests::nothingCountedWhenNoFieldNeededQuotes);
        runner.test("an unsafe separator is rejected", CsvExportTests::unsafeSeparatorIsRejected);
        runner.test("an empty separator falls back to a comma", CsvExportTests::emptySeparatorFallsBack);
        runner.test("an unknown quoting name falls back to minimal", CsvExportTests::unknownQuotingFallsBack);
        runner.test("the BOM and the header are optional", CsvExportTests::bomAndHeaderAreOptional);
    }

    // ------------------------------------------------------------------
    // tests
    // ------------------------------------------------------------------

    private static void multiCharacterSeparator() throws IOException {
        Written written = write(options("~@~", CsvExport.Quoting.MINIMAL, false), List.of("a", "b"));

        Assert.equal("a~@~b\r\n", written.text(), "the separator between two plain fields");
        Assert.equal(0L, written.unquoted(), "nothing needed quoting");
    }

    private static void fieldWithSeparatorIsQuoted() throws IOException {
        Written written = write(options("~@~", CsvExport.Quoting.MINIMAL, false), List.of("x~@~y", "plain"));

        // The whole separator has to be found, not its first character: `x~y` must not be quoted.
        Assert.equal("\"x~@~y\"~@~plain\r\n", written.text(), "a field containing the whole separator");
    }

    private static void partialSeparatorIsLeftAlone() throws IOException {
        Written written = write(options("~@~", CsvExport.Quoting.MINIMAL, false), List.of("a~b", "c@d"));

        Assert.equal("a~b~@~c@d\r\n", written.text(), "fields containing part of the separator");
        Assert.equal(0L, written.unquoted(), "nothing needed quoting");
    }

    private static void embeddedQuoteIsDoubled() throws IOException {
        Written written = write(options(",", CsvExport.Quoting.MINIMAL, false), List.of("he said \"hi\"", "x"));

        Assert.equal("\"he said \"\"hi\"\"\",x\r\n", written.text(), "an embedded quote");
    }

    private static void alwaysQuotesEverything() throws IOException {
        Written written = write(options(";", CsvExport.Quoting.ALWAYS, true), List.of("a", "b"));

        Assert.equal("\"c1\"\r\n\"a\";\"b\"\r\n", written.text(), "every field quoted, header included");
    }

    private static void neverQuotesAndCounts() throws IOException {
        Written written = write(options(",", CsvExport.Quoting.NEVER, false), List.of("x,y", "plain"));

        Assert.equal("x,y,plain\r\n", written.text(), "the field is written as it is");
        Assert.equal(1L, written.unquoted(), "one field was written without the quotes it needed");
    }

    private static void nothingCountedWhenNoFieldNeededQuotes() throws IOException {
        // Quoting off is only worth reporting when it actually changed the meaning of a value; a file of
        // plain fields is exactly what the user asked for.
        Written written = write(options(",", CsvExport.Quoting.NEVER, false), List.of("a", "b"));

        Assert.equal("a,b\r\n", written.text(), "plain fields");
        Assert.equal(0L, written.unquoted(), "nothing needed quoting");
    }

    private static void unsafeSeparatorIsRejected() {
        // A separator containing a quote or a line break produces a file nobody can parse back, and
        // quietly substituting another separator would hide that from whoever reads the file later.
        for (String separator : List.of("\"", "\n", "\r", "a\"b")) {
            Assert.throwsError(
                    IllegalArgumentException.class,
                    () -> options(separator, CsvExport.Quoting.MINIMAL, true),
                    "a separator of " + separator.replace("\n", "\\n").replace("\r", "\\r"));
        }
    }

    private static void emptySeparatorFallsBack() {
        Assert.equal(",", options("", CsvExport.Quoting.MINIMAL, true).delimiter(), "an empty separator");
        Assert.equal(",", options(null, CsvExport.Quoting.MINIMAL, true).delimiter(), "a missing separator");
    }

    private static void unknownQuotingFallsBack() {
        Assert.equal(CsvExport.Quoting.MINIMAL, CsvExport.Quoting.parse(null), "a missing name");
        Assert.equal(CsvExport.Quoting.MINIMAL, CsvExport.Quoting.parse("nonsense"), "an unknown name");
        Assert.equal(CsvExport.Quoting.ALWAYS, CsvExport.Quoting.parse("ALWAYS"), "always, in any case");
        Assert.equal(CsvExport.Quoting.NEVER, CsvExport.Quoting.parse(" never "), "never, padded");
    }

    private static void bomAndHeaderAreOptional() throws IOException {
        Written with = write(new CsvExport.Options(",", CsvExport.Quoting.MINIMAL, true, true, false), List.of("a"));
        Assert.equal("\uFEFFc1\r\na\r\n", with.text(), "BOM and header");

        Written without = write(options(",", CsvExport.Quoting.MINIMAL, false), List.of("a"));
        Assert.equal("a\r\n", without.text(), "neither");
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    /** A written file: its text as a reader would see it, and how many fields were left unquoted. */
    private record Written(String text, long unquoted) {
    }

    private static CsvExport.Options options(String delimiter, CsvExport.Quoting quoting, boolean includeHeader) {
        return new CsvExport.Options(delimiter, quoting, includeHeader, false, false);
    }

    /** Writes one row of one column and reads the file back. */
    private static Written write(CsvExport.Options options, List<String> values) throws IOException {
        Path file = Files.createTempFile("csv-export-test-", ".csv");
        try {
            long unquoted;
            try (CsvExport exporter = new CsvExport(file, options)) {
                exporter.begin(List.of(column("c1")));
                exporter.row(new ArrayList<Object>(values));
                exporter.end();
                // Read before the close below, and after the last row: this is when the whole file's
                // worth of quoting decisions has been made.
                unquoted = exporter.unquotedFields();
            }
            return new Written(Files.readString(file, StandardCharsets.UTF_8), unquoted);
        } finally {
            Files.deleteIfExists(file);
        }
    }

    private static ResultColumn column(String name) {
        return new ResultColumn(
                name, name, null, null, null, null, "VARCHAR", Types.VARCHAR, 0, 0, true, "varchar");
    }
}

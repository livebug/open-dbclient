package com.opendbclient.bridge.export;

import java.io.BufferedOutputStream;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import com.opendbclient.bridge.log.Log;
import com.opendbclient.bridge.result.ResultColumn;

/**
 * Writes a minimal {@code .xlsx} workbook.
 *
 * <h2>Why this is hand-written</h2>
 *
 * Apache POI is the obvious choice and would add roughly ten megabytes to an artifact whose entire
 * purpose is to stay small and dependency-free - the bridge is a bare {@code java -jar} program for a
 * reason, namely that it has to coexist with whatever fat driver jar a user supplies. An {@code xlsx}
 * is a ZIP of XML parts, and the subset needed to emit a worksheet of values is small enough to write
 * directly and to keep streaming.
 *
 * <h2>Streaming with more than one sheet</h2>
 *
 * A ZIP's entries are written in sequence and its table of contents is built as it goes, but Excel
 * requires {@code [Content_Types].xml} to declare every worksheet - and that file is written first.
 * The sheet count is only known once the data has been read, which is the whole difficulty. Rather
 * than give up and impose a single-sheet limit, each sheet is streamed to a temporary file and the
 * archive is assembled afterwards. Memory stays bounded by the write buffers; only disk grows, and
 * only by the size of the output the user asked for.
 *
 * <h2>Strings are inline</h2>
 *
 * The usual shared-string table would deduplicate repeated values, but it needs the whole column in
 * memory to build, which is exactly what this design avoids. Inline strings trade some file size for
 * the guarantee that memory use is independent of row count.
 */
public final class XlsxExport implements ExportTarget {

    /** Excel refuses to open a worksheet with more rows than this. */
    private static final int EXCEL_MAX_ROWS = 1_048_576;

    private static final String WORKSHEET_NAMESPACE =
            "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    private static final String RELATIONSHIPS_NAMESPACE =
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    private static final String PACKAGE_RELATIONSHIPS_NAMESPACE =
            "http://schemas.openxmlformats.org/package/2006/relationships";

    private final Path target;
    private final int maxRowsPerSheet;
    private final boolean includeHeader;

    private final List<Path> sheetFiles = new ArrayList<>();

    private Path currentSheetFile;
    private Writer sheetWriter;
    private int rowsInSheet;
    private int sheetNumber;

    public XlsxExport(Path target, int maxRowsPerSheet, boolean includeHeader) {
        this.target = target;
        // Clamped rather than trusted: a larger value would produce a workbook Excel cannot open.
        this.maxRowsPerSheet = Math.min(EXCEL_MAX_ROWS, Math.max(1, maxRowsPerSheet));
        this.includeHeader = includeHeader;
    }

    @Override
    public void begin(List<ResultColumn> columns) throws IOException {
        startSheet(columns, true);
    }

    @Override
    public void row(List<Object> values) throws IOException {
        if (rowsInSheet >= maxRowsPerSheet) {
            // Roll over: finish the current worksheet and begin another.
            startSheet(null, false);
        }
        writeRow(values);
    }

    @Override
    public void end() throws IOException {
        closeCurrentSheet();
        assembleWorkbook();
    }

    @Override
    public void close() throws IOException {
        closeCurrentSheet();
        for (Path sheet : sheetFiles) {
            try {
                Files.deleteIfExists(sheet);
            } catch (IOException failure) {
                Log.debug("Could not delete the temporary worksheet %s: %s", sheet, failure.getMessage());
            }
        }
        sheetFiles.clear();
    }

    // ------------------------------------------------------------------
    // worksheet streaming
    // ------------------------------------------------------------------

    private void startSheet(List<ResultColumn> columns, boolean isFirst) throws IOException {
        closeCurrentSheet();

        sheetNumber++;
        currentSheetFile = Files.createTempFile("open-dbclient-sheet-", ".xml");
        sheetFiles.add(currentSheetFile);

        sheetWriter = new BufferedWriter(
                new OutputStreamWriter(Files.newOutputStream(currentSheetFile), StandardCharsets.UTF_8), 64 * 1024);
        sheetWriter.write("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>");
        sheetWriter.write("<worksheet xmlns=\"" + WORKSHEET_NAMESPACE + "\"><sheetData>");

        rowsInSheet = 0;
        if (isFirst && includeHeader && columns != null) {
            List<Object> header = new ArrayList<>(columns.size());
            for (ResultColumn column : columns) {
                header.add(column.label());
            }
            writeRow(header);
        }
    }

    private void closeCurrentSheet() throws IOException {
        if (sheetWriter == null) {
            return;
        }
        sheetWriter.write("</sheetData></worksheet>");
        sheetWriter.close();
        sheetWriter = null;
        currentSheetFile = null;
    }

    private void writeRow(List<Object> values) throws IOException {
        rowsInSheet++;
        sheetWriter.write("<row r=\"" + rowsInSheet + "\">");

        for (int i = 0; i < values.size(); i++) {
            Object value = values.get(i);
            if (value == null) {
                // An omitted cell is treated as empty, and skipping it keeps the file smaller than
                // emitting an explicit placeholder for every gap.
                continue;
            }

            String reference = columnLetter(i + 1) + rowsInSheet;
            if (value instanceof Boolean flag) {
                sheetWriter.write("<c r=\"" + reference + "\" t=\"b\"><v>" + (flag ? "1" : "0") + "</v></c>");
            } else if (value instanceof Number number) {
                sheetWriter.write("<c r=\"" + reference + "\"><v>" + number + "</v></c>");
            } else {
                sheetWriter.write("<c r=\"" + reference + "\" t=\"inlineStr\"><is><t xml:space=\"preserve\">"
                        + escapeXml(ExportTarget.renderText(value)) + "</t></is></c>");
            }
        }

        sheetWriter.write("</row>");
    }

    // ------------------------------------------------------------------
    // package assembly
    // ------------------------------------------------------------------

    private void assembleWorkbook() throws IOException {
        if (sheetFiles.isEmpty()) {
            throw new IOException("no worksheet was produced");
        }

        try (ZipOutputStream zip = new ZipOutputStream(
                new BufferedOutputStream(Files.newOutputStream(target), 64 * 1024))) {

            writeEntry(zip, "[Content_Types].xml", contentTypes(sheetFiles.size()));
            writeEntry(zip, "_rels/.rels", packageRelationships());
            writeEntry(zip, "xl/workbook.xml", workbook(sheetFiles.size()));
            writeEntry(zip, "xl/_rels/workbook.xml.rels", workbookRelationships(sheetFiles.size()));

            for (int i = 0; i < sheetFiles.size(); i++) {
                ZipEntry entry = new ZipEntry("xl/worksheets/sheet" + (i + 1) + ".xml");
                zip.putNextEntry(entry);
                Files.copy(sheetFiles.get(i), zip);
                zip.closeEntry();
            }
        }

        Log.debug("Wrote an xlsx workbook with %d worksheet(s) to %s", sheetFiles.size(), target);
    }

    private static void writeEntry(ZipOutputStream zip, String name, String content) throws IOException {
        zip.putNextEntry(new ZipEntry(name));
        zip.write(content.getBytes(StandardCharsets.UTF_8));
        zip.closeEntry();
    }

    private static String contentTypes(int sheetCount) {
        StringBuilder xml = new StringBuilder(512);
        xml.append("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>");
        xml.append("<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">");
        xml.append("<Default Extension=\"rels\" ")
                .append("ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>");
        xml.append("<Default Extension=\"xml\" ContentType=\"application/xml\"/>");
        xml.append("<Override PartName=\"/xl/workbook.xml\" ContentType=\"")
                .append("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>");
        for (int i = 1; i <= sheetCount; i++) {
            xml.append("<Override PartName=\"/xl/worksheets/sheet").append(i).append(".xml\" ContentType=\"")
                    .append("application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>");
        }
        return xml.append("</Types>").toString();
    }

    private static String packageRelationships() {
        return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
                + "<Relationships xmlns=\"" + PACKAGE_RELATIONSHIPS_NAMESPACE + "\">"
                + "<Relationship Id=\"rId1\" Type=\"" + RELATIONSHIPS_NAMESPACE + "/officeDocument\" "
                + "Target=\"xl/workbook.xml\"/>"
                + "</Relationships>";
    }

    private static String workbook(int sheetCount) {
        StringBuilder xml = new StringBuilder(256);
        xml.append("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>");
        xml.append("<workbook xmlns=\"").append(WORKSHEET_NAMESPACE)
                .append("\" xmlns:r=\"").append(RELATIONSHIPS_NAMESPACE).append("\"><sheets>");
        for (int i = 1; i <= sheetCount; i++) {
            xml.append("<sheet name=\"Sheet").append(i).append("\" sheetId=\"").append(i)
                    .append("\" r:id=\"rId").append(i).append("\"/>");
        }
        return xml.append("</sheets></workbook>").toString();
    }

    private static String workbookRelationships(int sheetCount) {
        StringBuilder xml = new StringBuilder(256);
        xml.append("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>");
        xml.append("<Relationships xmlns=\"").append(PACKAGE_RELATIONSHIPS_NAMESPACE).append("\">");
        for (int i = 1; i <= sheetCount; i++) {
            xml.append("<Relationship Id=\"rId").append(i).append("\" Type=\"").append(RELATIONSHIPS_NAMESPACE)
                    .append("/worksheet\" Target=\"worksheets/sheet").append(i).append(".xml\"/>");
        }
        return xml.append("</Relationships>").toString();
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    /** Converts a one-based column index to spreadsheet letters: 1 to A, 27 to AA. */
    static String columnLetter(int index) {
        StringBuilder letters = new StringBuilder(3);
        int remaining = index;
        while (remaining > 0) {
            int digit = (remaining - 1) % 26;
            letters.insert(0, (char) ('A' + digit));
            remaining = (remaining - 1) / 26;
        }
        return letters.toString();
    }

    /**
     * Escapes text for XML content.
     *
     * Control characters below 0x20 are dropped rather than escaped. XML 1.0 has no valid
     * representation for them, and a single one anywhere in the sheet makes Excel refuse to open the
     * whole workbook - so silently losing one character beats producing a file that cannot be read.
     */
    static String escapeXml(String text) {
        StringBuilder out = new StringBuilder(text.length() + 16);
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            switch (c) {
                case '&' -> out.append("&amp;");
                case '<' -> out.append("&lt;");
                case '>' -> out.append("&gt;");
                case '"' -> out.append("&quot;");
                case '\'' -> out.append("&apos;");
                default -> {
                    if (c == '\t' || c == '\n' || c == '\r' || c >= 0x20) {
                        out.append(c);
                    }
                }
            }
        }
        return out.toString();
    }
}

package com.opendbclient.bridge.metadata;

import java.util.Map;

import com.opendbclient.bridge.json.Json;

/**
 * A table, view or other table-like object.
 *
 * @param catalog  catalog it belongs to, or {@code null}
 * @param schema   schema it belongs to, or {@code null}
 * @param name     object name
 * @param type     the {@code TABLE_TYPE} string reported by the driver, e.g. {@code TABLE},
 *                 {@code VIEW}, {@code MATERIALIZED VIEW}, {@code FOREIGN TABLE}
 * @param remarks  comment, when the driver reports one
 */
public record TableInfo(
        String catalog,
        String schema,
        String name,
        String type,
        String remarks) {

    public Map<String, Object> toPayload() {
        Map<String, Object> payload = Json.obj("name", name, "type", type);
        if (catalog != null && !catalog.isEmpty()) {
            payload.put("catalog", catalog);
        }
        if (schema != null && !schema.isEmpty()) {
            payload.put("schema", schema);
        }
        if (remarks != null && !remarks.isBlank()) {
            payload.put("remarks", remarks);
        }
        return payload;
    }
}

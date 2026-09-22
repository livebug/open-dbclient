import type { JdbcBridge } from '../bridge/JdbcBridge';
import { Methods } from '../bridge/protocol';
import type {
  ColumnInfo,
  DatabaseCapabilities,
  IndexInfo,
  TableInfo,
} from '../bridge/protocol';

/** Identifies an object in a database, for the calls that need a fully qualified name. */
export interface ObjectReference {
  readonly connectionId: string;
  readonly catalog?: string;
  readonly schema?: string;
}

export interface TableRequest extends ObjectReference {
  /** LIKE pattern; `%` for everything. Passed to the driver unescaped. */
  readonly namePattern?: string;
  /** `TABLE_TYPE` labels to include; omit for everything the driver considers table-like. */
  readonly types?: readonly string[];
}

export interface TableReference extends ObjectReference {
  readonly table: string;
}

/**
 * Typed access to the bridge's metadata methods.
 *
 * A thin layer, but a deliberate one: it gives the tree, the SQL completion cache and the export
 * commands a single place to obtain schema information, and it centralises the wire convention that
 * an absent catalog or schema must be omitted rather than sent as an empty string - which the driver
 * would read as "objects with no schema" instead of "any schema".
 */
export class MetadataService {
  constructor(private readonly bridge: JdbcBridge) {}

  async capabilities(connectionId: string): Promise<DatabaseCapabilities> {
    return this.bridge.request<DatabaseCapabilities>(Methods.metadataCapabilities, { connectionId });
  }

  async catalogs(connectionId: string): Promise<string[]> {
    const result = await this.bridge.request<{ catalogs: string[] }>(Methods.metadataCatalogs, {
      connectionId,
    });
    return result.catalogs ?? [];
  }

  async schemas(connectionId: string, catalog?: string): Promise<string[]> {
    const params: Record<string, unknown> = { connectionId };
    putIfPresent(params, 'catalog', catalog);

    const result = await this.bridge.request<{ schemas: string[] }>(Methods.metadataSchemas, params);
    return result.schemas ?? [];
  }

  /** The `TABLE_TYPE` labels this driver uses, so callers can group without guessing. */
  async tableTypes(connectionId: string): Promise<string[]> {
    const result = await this.bridge.request<{ tableTypes: string[] }>(Methods.metadataTableTypes, {
      connectionId,
    });
    return result.tableTypes ?? [];
  }

  async tables(request: TableRequest): Promise<TableInfo[]> {
    const params: Record<string, unknown> = { connectionId: request.connectionId };
    putIfPresent(params, 'catalog', request.catalog);
    putIfPresent(params, 'schema', request.schema);
    if (request.namePattern) {
      params.namePattern = request.namePattern;
    }
    if (request.types && request.types.length > 0) {
      params.types = [...request.types];
    }

    const result = await this.bridge.request<{ tables: TableInfo[] }>(Methods.metadataTables, params);
    return result.tables ?? [];
  }

  async columns(reference: TableReference): Promise<ColumnInfo[]> {
    const result = await this.bridge.request<{ columns: ColumnInfo[] }>(
      Methods.metadataColumns,
      withTable(reference),
    );
    return result.columns ?? [];
  }

  async indexes(reference: TableReference): Promise<IndexInfo[]> {
    const result = await this.bridge.request<{ indexes: IndexInfo[] }>(
      Methods.metadataIndexes,
      withTable(reference),
    );
    return result.indexes ?? [];
  }

  async ddl(reference: TableReference): Promise<string> {
    const result = await this.bridge.request<{ ddl: string }>(Methods.metadataDdl, withTable(reference));
    return result.ddl ?? '';
  }
}

function withTable(reference: TableReference): Record<string, unknown> {
  const params: Record<string, unknown> = {
    connectionId: reference.connectionId,
    table: reference.table,
  };
  putIfPresent(params, 'catalog', reference.catalog);
  putIfPresent(params, 'schema', reference.schema);
  return params;
}

/**
 * Adds a key only when it carries a value.
 *
 * The bridge treats an absent key and an empty string differently, and so does JDBC: absent means
 * "any", empty means "the one with no name". Sending `''` for an unset catalog would filter the
 * result down to nothing on most databases.
 */
function putIfPresent(target: Record<string, unknown>, key: string, value: string | undefined): void {
  if (value !== undefined && value !== null && value !== '') {
    target[key] = value;
  }
}

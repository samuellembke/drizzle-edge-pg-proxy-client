/**
 * Creates a custom HTTP client for PostgreSQL that works in edge environments
 * This implementation mirrors Neon's HTTP client interface to ensure compatibility
 * with drizzle-orm, Auth.js and other tools that expect the Neon client.
 */

// Define basic types based on Neon's HTTP client
export interface PgQueryResult {
  command: string;
  fields: PgField[];
  rowCount: number;
  rows: any[];
  rowAsArray: boolean;
  // Additional properties for compatibility with Neon
  _parsers?: any[];
  _types?: TypeParser;
}

export interface PgField {
  name: string;
  tableID: number;
  columnID: number;
  dataTypeID: number;
  dataTypeSize: number;
  dataTypeModifier: number;
  format: string;
}

export interface ParameterizedQuery {
  query: string;
  params: any[];
}

// Custom PostgreSQL Error Class following Neon's pattern
export class PgError extends Error {
  override name = 'PgError' as const;

  // PostgreSQL specific error fields
  severity?: string;
  code?: string;
  detail?: string;
  hint?: string;
  position?: string;
  internalPosition?: string;
  internalQuery?: string;
  where?: string;
  schema?: string;
  table?: string;
  column?: string;
  dataType?: string;
  constraint?: string;
  file?: string;
  line?: string;
  routine?: string;

  // Original error if wrapped
  sourceError?: Error;

  constructor(message: string) {
    super(message);

    if ('captureStackTrace' in Error && typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, PgError);
    }
  }
}

// Standard PostgreSQL error fields for parsing from server responses
const PG_ERROR_FIELDS = [
  'severity',
  'code',
  'detail',
  'hint',
  'position',
  'internalPosition',
  'internalQuery',
  'where',
  'schema',
  'table',
  'column',
  'dataType',
  'constraint',
  'file',
  'line',
  'routine',
] as const;

// Class for RAW SQL representation
export class UnsafeRawSql {
  constructor(public sql: string) {}
}

// This is used to tag template literals in SQL queries
export type SQLTemplateTag = (strings: TemplateStringsArray, ...values: any[]) => QueryPromise<PgQueryResult>;

// PostgreSQL Data Types IDs
// Based on https://github.com/brianc/node-pg-types/blob/master/lib/builtins.js
export enum PgTypeId {
  BOOL = 16,
  BYTEA = 17,
  CHAR = 18,
  INT8 = 20,
  INT2 = 21,
  INT4 = 23,
  REGPROC = 24,
  TEXT = 25,
  OID = 26,
  TID = 27,
  XID = 28,
  CID = 29,
  JSON = 114,
  XML = 142,
  PG_NODE_TREE = 194,
  JSONB = 3802,
  FLOAT4 = 700,
  FLOAT8 = 701,
  ABSTIME = 702,
  RELTIME = 703,
  TINTERVAL = 704,
  CIRCLE = 718,
  MONEY = 790,
  MACADDR = 829,
  INET = 869,
  CIDR = 650,
  MACADDR8 = 774,
  ACLITEM = 1033,
  BPCHAR = 1042,
  VARCHAR = 1043,
  DATE = 1082,
  TIME = 1083,
  TIMESTAMP = 1114,
  TIMESTAMPTZ = 1184,
  INTERVAL = 1186,
  TIMETZ = 1266,
  BIT = 1560,
  VARBIT = 1562,
  NUMERIC = 1700,
  REFCURSOR = 1790,
  REGPROCEDURE = 2202,
  REGOPER = 2203,
  REGOPERATOR = 2204,
  REGCLASS = 2205,
  REGTYPE = 2206,
  UUID = 2950,
  TXID_SNAPSHOT = 2970,
  PG_LSN = 3220,
  PG_NDISTINCT = 3361,
  PG_DEPENDENCIES = 3402,
  TSVECTOR = 3614,
  TSQUERY = 3615,
  GTSVECTOR = 3642,
  REGCONFIG = 3734,
  REGDICTIONARY = 3769,
  JSONPATH = 4072,
  REGNAMESPACE = 4089,
  REGROLE = 4096,
  
  // Array types (OIDs are element type OID + 1 dimension)
  // Defining common array types explicitly
  BOOL_ARRAY = 1000,      // Boolean Array -> 16 + 1000 - 16 = 1000
  BYTEA_ARRAY = 1001,     // Bytea Array -> 17 + 1000 - 16 = 1001
  CHAR_ARRAY = 1002,      // Char Array -> 18 + 1000 - 16 = 1002
  INT8_ARRAY = 1016,      // BigInt Array -> 20 + 1000 - 4 = 1016
  INT2_ARRAY = 1005,      // SmallInt Array -> 21 + 1000 - 16 = 1005
  INT4_ARRAY = 1007,      // Integer Array -> 23 + 1000 - 16 = 1007
  TEXT_ARRAY = 1009,      // Text Array -> 25 + 1000 - 16 = 1009
  JSON_ARRAY = 199,       // JSON Array -> 114 + 1000 - 915 = 199
  JSONB_ARRAY = 3807,     // JSONB Array -> 3802 + 5 = 3807
  FLOAT4_ARRAY = 1021,    // Float4 Array -> 700 + 1000 - 679 = 1021
  FLOAT8_ARRAY = 1022,    // Float8 Array -> 701 + 1000 - 679 = 1022
  NUMERIC_ARRAY = 1231,   // Numeric Array -> 1700 + 1000 - 1469 = 1231
  DATE_ARRAY = 1182,      // Date Array -> 1082 + 100 = 1182
  TIMESTAMP_ARRAY = 1115, // Timestamp Array -> 1114 + 1 = 1115
  TIMESTAMPTZ_ARRAY = 1185, // Timestamptz Array -> 1184 + 1 = 1185
  UUID_ARRAY = 2951,      // UUID Array -> 2950 + 1 = 2951
  VARCHAR_ARRAY = 1015,   // VarChar Array -> 1043 + 1000 - 1028 = 1015
}

// Helper function to check if a type is an array type
export function isArrayType(typeId: number): boolean {
  // Array types in PostgreSQL are typically in ranges that follow patterns
  return (
    (typeId >= 1000 && typeId <= 1099) || // Common 1-dimensional array types
    (typeId >= 1115 && typeId <= 1185) || // Date/time array types
    typeId === 199 ||                     // JSON array
    typeId === 3807 ||                    // JSONB array
    typeId === 1231 ||                    // Numeric array
    typeId === 2951                       // UUID array
    // Add other ranges as needed
  );
}

// Get the element type ID for an array type ID
export function getElementTypeId(arrayTypeId: number): number {
  // Some common mappings for array types to their element types
  const arrayToElementMap: Record<number, number> = {
    1000: PgTypeId.BOOL,          // Boolean array -> Boolean
    1001: PgTypeId.BYTEA,         // Bytea array -> Bytea
    1002: PgTypeId.CHAR,          // Char array -> Char
    1005: PgTypeId.INT2,          // SmallInt array -> SmallInt
    1007: PgTypeId.INT4,          // Integer array -> Integer
    1009: PgTypeId.TEXT,          // Text array -> Text
    1016: PgTypeId.INT8,          // BigInt array -> BigInt
    1021: PgTypeId.FLOAT4,        // Float4 array -> Float4
    1022: PgTypeId.FLOAT8,        // Float8 array -> Float8
    1231: PgTypeId.NUMERIC,       // Numeric array -> Numeric
    1015: PgTypeId.VARCHAR,       // VarChar array -> VarChar
    1182: PgTypeId.DATE,          // Date array -> Date
    1115: PgTypeId.TIMESTAMP,     // Timestamp array -> Timestamp
    1185: PgTypeId.TIMESTAMPTZ,   // TimestampTZ array -> TimestampTZ
    199: PgTypeId.JSON,           // JSON array -> JSON
    3807: PgTypeId.JSONB,         // JSONB array -> JSONB
    2951: PgTypeId.UUID,          // UUID array -> UUID
  };

  return arrayToElementMap[arrayTypeId] || 0;
}


// Type parser for PostgreSQL types
export class TypeParser {
  private parsers: Record<number, (value: string) => any> = {};

  constructor(customTypes?: Record<number, (value: string) => any>) {
    // Initialize with default parsers
    this.initializeDefaultParsers();
    
    // Add custom type parsers if provided
    if (customTypes) {
      Object.keys(customTypes).forEach(key => {
        const typeId = parseInt(key, 10);
        if (!isNaN(typeId) && customTypes[typeId]) {
          this.setTypeParser(typeId, customTypes[typeId] as (value: string) => any);
        }
      });
    }
  }

  private initializeDefaultParsers() {
    // Boolean type
    this.setTypeParser(PgTypeId.BOOL, val => val === 't' || val === 'true');
    
    // Integer types
    this.setTypeParser(PgTypeId.INT2, val => parseInt(val, 10));
    this.setTypeParser(PgTypeId.INT4, val => parseInt(val, 10));
    this.setTypeParser(PgTypeId.INT8, val => BigInt(val));
    this.setTypeParser(PgTypeId.OID, val => parseInt(val, 10));
    
    // Floating point types
    this.setTypeParser(PgTypeId.FLOAT4, val => parseFloat(val));
    this.setTypeParser(PgTypeId.FLOAT8, val => parseFloat(val));
    this.setTypeParser(PgTypeId.NUMERIC, val => parseFloat(val));
    
    // JSON types
    this.setTypeParser(PgTypeId.JSON, val => JSON.parse(val));
    this.setTypeParser(PgTypeId.JSONB, val => JSON.parse(val));
    
    // Date/Time types
    this.setTypeParser(PgTypeId.DATE, val => new Date(val));
    this.setTypeParser(PgTypeId.TIMESTAMP, val => new Date(val));
    this.setTypeParser(PgTypeId.TIMESTAMPTZ, val => new Date(val));
    
    // UUID
    this.setTypeParser(PgTypeId.UUID, val => val);
    
    // Set up array type parsers
    this.setupArrayTypeParsers();
  }

  private setupArrayTypeParsers() {
    // Define array type parsers for all base types
    // Boolean array
    this.setTypeParser(PgTypeId.BOOL_ARRAY, val => 
      parsePostgresArray(val, this.getTypeParser(PgTypeId.BOOL)));
    
    // Integer arrays
    this.setTypeParser(PgTypeId.INT2_ARRAY, val => 
      parsePostgresArray(val, this.getTypeParser(PgTypeId.INT2)));
    this.setTypeParser(PgTypeId.INT4_ARRAY, val => 
      parsePostgresArray(val, this.getTypeParser(PgTypeId.INT4)));
    this.setTypeParser(PgTypeId.INT8_ARRAY, val => 
      parsePostgresArray(val, this.getTypeParser(PgTypeId.INT8)));
    
    // Floating point arrays
    this.setTypeParser(PgTypeId.FLOAT4_ARRAY, val => 
      parsePostgresArray(val, this.getTypeParser(PgTypeId.FLOAT4)));
    this.setTypeParser(PgTypeId.FLOAT8_ARRAY, val => 
      parsePostgresArray(val, this.getTypeParser(PgTypeId.FLOAT8)));
    this.setTypeParser(PgTypeId.NUMERIC_ARRAY, val => 
      parsePostgresArray(val, this.getTypeParser(PgTypeId.NUMERIC)));
    
    // Text arrays
    this.setTypeParser(PgTypeId.TEXT_ARRAY, val => 
      parsePostgresArray(val, this.getTypeParser(PgTypeId.TEXT)));
    this.setTypeParser(PgTypeId.VARCHAR_ARRAY, val => 
      parsePostgresArray(val, this.getTypeParser(PgTypeId.VARCHAR)));
    
    // JSON arrays
    this.setTypeParser(PgTypeId.JSON_ARRAY, val => 
      parsePostgresArray(val, this.getTypeParser(PgTypeId.JSON)));
    this.setTypeParser(PgTypeId.JSONB_ARRAY, val => 
      parsePostgresArray(val, this.getTypeParser(PgTypeId.JSONB)));
    
    // Date/Time arrays
    this.setTypeParser(PgTypeId.DATE_ARRAY, val => 
      parsePostgresArray(val, this.getTypeParser(PgTypeId.DATE)));
    this.setTypeParser(PgTypeId.TIMESTAMP_ARRAY, val => 
      parsePostgresArray(val, this.getTypeParser(PgTypeId.TIMESTAMP)));
    this.setTypeParser(PgTypeId.TIMESTAMPTZ_ARRAY, val => 
      parsePostgresArray(val, this.getTypeParser(PgTypeId.TIMESTAMPTZ)));
    
    // UUID array
    this.setTypeParser(PgTypeId.UUID_ARRAY, val => 
      parsePostgresArray(val, this.getTypeParser(PgTypeId.UUID)));
  }

  public setTypeParser(typeId: number, parseFn: (value: string) => any): void {
    this.parsers[typeId] = parseFn;
  }

  public getTypeParser(typeId: number): (value: string) => any {
    // If we're asked for a parser for an array type that doesn't have one explicitly defined,
    // create an array parser dynamically using the element type parser
    if (isArrayType(typeId) && !this.parsers[typeId]) {
      const elementTypeId = getElementTypeId(typeId);
      if (elementTypeId) {
        const elementParser = this.getTypeParser(elementTypeId);
        return (value: string) => parsePostgresArray(value, elementParser);
      }
    }
    
    return this.parsers[typeId] || (value => value);
  }
}

// Create a class implementing Promise for SQL queries with expanded functionality to match Neon's
export class QueryPromise<T = any> implements Promise<T> {
  readonly [Symbol.toStringTag]: string = 'Promise';
  public queryData: ParameterizedQuery;
  public opts?: any;

  constructor(
    private executeFn: (query: string, params: any[]) => Promise<T>,
    queryObj: ParameterizedQuery,
    opts?: any
  ) {
    this.queryData = queryObj;
    this.opts = opts;
  }

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null | undefined,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null | undefined
  ): Promise<TResult1 | TResult2> {
    return this.executeFn(this.queryData.query, this.queryData.params).then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null | undefined
  ): Promise<T | TResult> {
    return this.executeFn(this.queryData.query, this.queryData.params).catch(onrejected);
  }

  finally(onfinally?: (() => void) | null | undefined): Promise<T> {
    return this.executeFn(this.queryData.query, this.queryData.params).finally(onfinally);
  }
  
  // For compatibility with result iteration, implement Symbol.iterator
  [Symbol.iterator](): Iterator<T> {
    // Create a reference to the promise outside the iterator
    const promise = this;
    let isDone = false;
    let resolvedValue: T | undefined = undefined;
    
    return {
      next(): IteratorResult<T> {
        if (isDone) {
          return { done: true, value: undefined as any };
        }
        
        if (resolvedValue === undefined) {
          // For the first call, return the promise result
          return promise.then((value: T) => {
            resolvedValue = value;
            isDone = true;
            return { done: false, value };
          }) as any;
        }
        
        // For subsequent calls (after the promise resolved)
        isDone = true;
        return { done: false, value: resolvedValue };
      }
    };
  }
}

// Helper function to handle PostgreSQL error parsing
function parsePostgresError(err: any): PgError {
  const pgError = new PgError(err.message || 'Unknown PostgreSQL error');
  
  // Copy all PostgreSQL error fields if they exist
  for (const field of PG_ERROR_FIELDS) {
    if (err[field] !== undefined) {
      pgError[field] = err[field];
    }
  }
  
  // Store original error if available
  if (err instanceof Error) {
    pgError.sourceError = err;
  }
  
  return pgError;
}

// Helper function to encode binary data for PostgreSQL
function encodeBuffersAsBytea(value: unknown): unknown {
  // Convert Buffer to bytea hex format: https://www.postgresql.org/docs/current/datatype-binary.html
  if (value instanceof Buffer || (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value))) {
    return '\\x' + Buffer.from(value as any).toString('hex');
  }
  return value;
}

/**
 * Parse a PostgreSQL array string into a JavaScript array
 * This handles various array types and dimensions using the appropriate element parser
 */
function parsePostgresArray(arrayString: string, elementParser: (value: string) => any): any[] {
  if (!arrayString || arrayString === '{}') return [];
  if (arrayString[0] !== '{' || arrayString[arrayString.length - 1] !== '}') {
    throw new Error(`Invalid PostgreSQL array format: ${arrayString}`);
  }

  // Extract the content inside the outer braces
  const content = arrayString.substring(1, arrayString.length - 1);
  
  // Quick return for empty arrays
  if (!content) return [];
  
  const result: any[] = [];
  let inQuotes = false;
  let inEscape = false;
  let currentItem = '';
  let nestLevel = 0; 
  
  // Process each character to handle quotes, escapes, and nested arrays
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    
    // Handle escape sequences
    if (inEscape) {
      currentItem += char;
      inEscape = false;
      continue;
    }
    
    // Start of escape sequence
    if (char === '\\') {
      inEscape = true;
      continue;
    }
    
    // Toggle quote mode when we see a quote
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    
    // Track nesting level for nested arrays
    if (char === '{') {
      nestLevel++;
      currentItem += char;
      continue;
    }
    
    if (char === '}') {
      nestLevel--;
      currentItem += char;
      continue;
    }
    
    // If we're inside quotes or a nested array, add the character to current item
    if (inQuotes || nestLevel > 0) {
      currentItem += char;
      continue;
    }
    
    // Handle item separator (comma)
    if (char === ',') {
      // Process the completed item
      result.push(parseArrayItem(currentItem, elementParser));
      currentItem = '';
      continue;
    }
    
    // Normal character, add to current item
    currentItem += char;
  }
  
  // Add the last item if there is one
  if (currentItem) {
    result.push(parseArrayItem(currentItem, elementParser));
  }
  
  return result;
}

/**
 * Parse a single item from a PostgreSQL array
 */
function parseArrayItem(item: string, elementParser: (value: string) => any): any {
  // Trim whitespace
  item = item.trim();
  
  // Handle NULL values
  if (item === 'NULL' || item === '') {
    return null;
  }
  
  // Handle nested arrays recursively
  if (item[0] === '{' && item[item.length - 1] === '}') {
    return parsePostgresArray(item, elementParser);
  }
  
  // Parse normal values using the element parser
  return elementParser(item);
}

// Process raw query results to apply type parsing
function processQueryResult(
  result: any,
  typeParser: TypeParser,
  arrayMode: boolean
): any {
  if (!result) return null;
  
  const fields = result.fields || [];
  const rowsData = result.rows || [];
  
  // Create parsers for each column based on its data type
  const parsers = fields.map((field: { dataTypeID: number }) => {
    const typeId = field.dataTypeID;
    
    // If it's an array type, create a special parser that handles the array format
    // and applies the element type parser to each item
    if (isArrayType(typeId)) {
      const elementTypeId = getElementTypeId(typeId);
      const elementParser = typeParser.getTypeParser(elementTypeId);
      
      // Return a function that parses the PostgreSQL array format
      return (value: string) => parsePostgresArray(value, elementParser);
    }
    
    // For non-array types, use the normal type parser
    return typeParser.getTypeParser(typeId);
  });
  
  // Extract column names
  const colNames = fields.map((field: { name: string }) => field.name);
  
      // Process rows with type parsers - with additional safety checks for Auth.js compatibility
      let processedRows: any[] = [];
      
      if (Array.isArray(rowsData)) {
        processedRows = arrayMode
          ? rowsData.map((row: any) => {
              // Ensure row is an array before trying to map over it
              if (!Array.isArray(row)) {
                return row; // Return as is if not an array
              }
              return row.map((val, i) => val === null ? null : parsers[i](val));
            })
          : rowsData.map((row: any) => {
              // Handle cases where row might not be an array (Auth.js sometimes sends objects directly)
              if (!Array.isArray(row)) {
                return row; // Return as is if not an array
              }
              
              const obj: Record<string, any> = {};
              row.forEach((val, i) => {
                if (i < colNames.length) { // Ensure index is within bounds
                  obj[colNames[i]] = val === null ? null : parsers[i](val);
                }
              });
              return obj;
            });
      }
  
  // Return a complete result object
  return {
    ...result,
    rows: processedRows,
    rowAsArray: arrayMode,
    _parsers: parsers,
    _types: typeParser
  };
}

// Transaction query interface for Auth.js compatibility
export interface TransactionQuery {
  text: string;
  values: unknown[];
  captureUserId?: boolean;
}

export interface ClientOptions {
  proxyUrl: string;
  authToken?: string;
  fetch?: typeof globalThis.fetch;
  arrayMode?: boolean;
  fullResults?: boolean;
  typeParser?: TypeParser | Record<number, (value: string) => any>;
}

export function createPgHttpClient({
  proxyUrl,
  authToken,
  fetch: customFetch,
  arrayMode = false,
  fullResults = false,
  typeParser: customTypeParser,
}: ClientOptions) {
  // Use provided fetch or global fetch
  const fetchFn = customFetch || globalThis.fetch;

  // Format the proxy URL to ensure it's valid
  const formattedProxyUrl = proxyUrl.endsWith('/') ? proxyUrl.slice(0, -1) : proxyUrl;
  
  // Initialize type parser
  const typeParser = customTypeParser instanceof TypeParser 
    ? customTypeParser
    : new TypeParser(customTypeParser);
  
  // Check if fetch is available in the current environment
  if (!fetchFn) {
    throw new PgError('fetch is not available in the current environment. Please provide a fetch implementation.');
  }

  // Direct query execution function - the core of the client
  const execute = async (query: string, params: any[] = []): Promise<PgQueryResult> => {
    const fetchOptions: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Add Neon-specific headers for compatibility
        'Neon-Raw-Text-Output': 'true', 
        'Neon-Array-Mode': String(arrayMode),
        // IMPORTANT: Always include Authorization header first if authToken is provided
        // to ensure compatibility with all server implementations
        ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({
        sql: query,
        params: Array.isArray(params) ? params.map(param => encodeBuffersAsBytea(param)) : [],
        method: 'all',
      }),
    };
    
    try {
      const response = await fetchFn(`${formattedProxyUrl}/query`, fetchOptions);

      if (!response.ok) {
        let errorData: any = { error: response.statusText };
        
        try {
          errorData = await response.json();
        } catch (parseError) {
          // If we can't parse JSON, use the status text
          errorData = { 
            error: `Status ${response.status}: ${response.statusText}` 
          };
        }
        
        // Create a proper PostgreSQL error
        const pgError = new PgError(errorData.error || errorData.message || `PostgreSQL HTTP proxy error: ${response.statusText}`);
        
        // Copy all PostgreSQL error fields if they exist
        for (const field of PG_ERROR_FIELDS) {
          if (errorData[field] !== undefined) {
            pgError[field] = errorData[field];
          }
        }
        
        throw pgError;
      }

      // Parse the rows from the response
      const result = await response.json() as any;
      
      // If the response already has the Neon format
      if (result.command && result.fields && Array.isArray(result.rows)) {
        // Process with type parsers
        return processQueryResult(result, typeParser, arrayMode);
      }
      
      // Handle simpler format (just an array of rows)
      const rows = Array.isArray(result) ? result : (result?.rows || []);
      
      // Determine command type from the query for proper result formatting
      let command = 'SELECT';
      const upperQuery = query.trim().toUpperCase();
      if (upperQuery.startsWith('INSERT')) command = 'INSERT';
      else if (upperQuery.startsWith('UPDATE')) command = 'UPDATE';
      else if (upperQuery.startsWith('DELETE')) command = 'DELETE';
      
      // Create a structured result
      const structuredResult = {
        command,
        fields: result?.fields || [],
        rowCount: Array.isArray(rows) ? rows.length : 0,
        rows: rows,
        rowAsArray: arrayMode
      };
      
      // Process with type parsers
      const processed = processQueryResult(structuredResult, typeParser, arrayMode);
      
      // Return the processed result or just the rows based on fullResults
      return fullResults ? processed : processed.rows;
    } catch (error) {
      if (error instanceof PgError) {
        throw error; // Already formatted as a PgError
      }
      
      // Create a connection error
      const connError = new PgError(`Failed to connect to PostgreSQL HTTP proxy at ${formattedProxyUrl}: ${error instanceof Error ? error.message : String(error)}`);
      connError.sourceError = error instanceof Error ? error : undefined;
      throw connError;
    }
  };

  /**
   * Helper to convert SqlTemplate to ParameterizedQuery
   * This mirrors Neon's sqlTemplate.toParameterizedQuery
   */
  const toParameterizedQuery = (
    strings: TemplateStringsArray, 
    values: any[]
  ): ParameterizedQuery => {
    let query = '';
    const params: any[] = [];

    for (let i = 0, len = strings.length; i < len; i++) {
      query += strings[i];
      if (i < values.length) {
        const value = values[i];
        
        // Handle different value types
        if (value instanceof UnsafeRawSql) {
          query += value.sql;
        } else if (value instanceof QueryPromise) {
          if (value.queryData) {
            // Inline the query text but not params
            query += value.queryData.query;
          } else {
            throw new PgError('This query is not composable');
          }
        } else {
          params.push(value);
          query += `$${params.length}`;
          
          // Type hint for binary data
          const isBinary = value instanceof Buffer || (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value));
          if (isBinary) query += '::bytea';
        }
      }
    }
    
    return { query, params };
  };

  // SQL tag template for handling raw SQL queries
  const sql = (strings: TemplateStringsArray, ...values: unknown[]): QueryPromise<PgQueryResult> => {
    const parameterizedQuery = toParameterizedQuery(strings, values);
    return new QueryPromise(execute, parameterizedQuery);
  };

  // No need to redefine TransactionQuery here as it's already defined and exported
  
  // Transaction handling with improved options support and Auth.js compatibility
  const transaction = async (
    queries: TransactionQuery[],
    options?: {
      isolationLevel?: 'ReadUncommitted' | 'ReadCommitted' | 'RepeatableRead' | 'Serializable';
      readOnly?: boolean;
      deferrable?: boolean;
      arrayMode?: boolean;
      fullResults?: boolean;
    }
  ): Promise<PgQueryResult[]> => {
    try {
      // Ensure queries is an array
      if (!Array.isArray(queries)) {
        queries = [];
      }
      
      // Auth.js compatibility: Handle DEFAULT keyword for user_id by transforming the queries
      // This is a critical fix for the Auth.js adapter which uses DEFAULT for user_id in account creation
      let userId: string | null = null;
      
      // Look for queries that might contain INSERT...RETURNING user ID
      for (let i = 0; i < queries.length; i++) {
        const queryText = queries[i]?.text || '';
        
        // Check if this is a user insert query with RETURNING
        if (queryText.toLowerCase().includes('insert into') && 
            queryText.toLowerCase().includes('user') && 
            queryText.toLowerCase().includes('returning')) {
          
          // Mark this query to capture its user ID result
          // Using safe access with a fallback object for possibly undefined query
          const currentQuery = queries[i] || { text: '', values: [] };
          queries[i] = {
            text: currentQuery.text || '',
            values: currentQuery.values || [],
            captureUserId: true 
          };
          break;
        }
      }
      
      // Format each query, transforming as needed for Auth.js compatibility
      const formattedQueries = queries.map((q, index) => {
        let sql = q.text || '';
        const params = Array.isArray(q.values) ? q.values.map(value => encodeBuffersAsBytea(value)) : [];
        
        // Handle user_id DEFAULT replacement with actual userId (if we've captured it)
        // This fixes the Auth.js pattern where it uses DEFAULT for user_id in account creation
        if (userId && 
            sql.toLowerCase().includes('insert into') && 
            sql.toLowerCase().includes('account') &&
            sql.toLowerCase().includes('user_id') && 
            sql.toLowerCase().includes('default')) {
          
          // Replace 'user_id', 'default') with 'user_id', $N)
          // Use a regex to find and replace the pattern
          if (sql.match(/user_id[^,]*,\s*default\)/i)) {
            const paramIndex = params.length + 1;
            sql = sql.replace(/user_id[^,]*,\s*default\)/i, `user_id", $${paramIndex})`);
            params.push(userId);
          }
        }
        
        return {
          sql,
          params,
          method: 'all',
          captureUserId: q.captureUserId
        };
      });

      // Determine the array mode and full results settings
      const txnArrayMode = options?.arrayMode ?? arrayMode;
      const txnFullResults = options?.fullResults ?? fullResults;

      // Prepare headers with transaction options
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        // Add Neon-specific headers for compatibility
        'Neon-Raw-Text-Output': 'true',
        'Neon-Array-Mode': String(txnArrayMode),
        // IMPORTANT: Always include Authorization header first if authToken is provided
        // to ensure compatibility with all server implementations
        ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {})
      };
      
      // Add transaction options if provided
      if (options?.isolationLevel) {
        headers['Neon-Batch-Isolation-Level'] = options.isolationLevel;
      }
      
      if (options?.readOnly !== undefined) {
        headers['Neon-Batch-Read-Only'] = String(options.readOnly);
      }
      
      if (options?.deferrable !== undefined) {
        headers['Neon-Batch-Deferrable'] = String(options.deferrable);
      }

      // Send the transaction request
      const response = await fetchFn(`${formattedProxyUrl}/transaction`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          queries: formattedQueries
        }),
      });

      if (!response.ok) {
        let errorData: any = {};
        try {
          errorData = await response.json();
        } catch {
          errorData = { error: `Status ${response.status}: ${response.statusText}` };
        }
        
        // Create a proper PostgreSQL error
        const pgError = new PgError(errorData.error || errorData.message || `PostgreSQL HTTP transaction error: ${response.statusText}`);
        
        // Copy all PostgreSQL error fields if they exist
        for (const field of PG_ERROR_FIELDS) {
          if (errorData[field] !== undefined) {
            pgError[field] = errorData[field];
          }
        }
        
        throw pgError;
      }

      // Parse results from response
      let results: any[] = [];
      try {
        const json = await response.json() as any;
        results = json.results || json;
      } catch (error) {
        throw new PgError(`Error parsing transaction response: ${error}`);
      }
      
      // Format each result to match what Neon returns
      const formattedResults = Array.isArray(results) ? results.map((result, i) => {
        // Determine the command type from the query
        let command = 'SELECT';
        const query = formattedQueries[i]?.sql || '';
        
        if (query.trim().toUpperCase().startsWith('INSERT')) command = 'INSERT';
        else if (query.trim().toUpperCase().startsWith('UPDATE')) command = 'UPDATE';
        else if (query.trim().toUpperCase().startsWith('DELETE')) command = 'DELETE';
        
        // Create a structured result if needed
        const structuredResult = result.command 
          ? result 
          : {
              command,
              fields: result.fields || [],
              rowCount: Array.isArray(result.rows || result) ? (result.rows || result).length : 0,
              rows: result.rows || result,
              rowAsArray: txnArrayMode
            };
        
        // Process with type parsers
        const processed = processQueryResult(structuredResult, typeParser, txnArrayMode);
        
        // Check if this is a user creation query and extract the user ID
        // This is essential for Auth.js compatibility
        if (formattedQueries[i]?.captureUserId && 
            processed.rows && 
            processed.rows.length > 0 && 
            processed.rows[0]?.id) {
          userId = processed.rows[0].id;
          console.log('Captured user ID from query result:', userId);
        }
        
        // Return the processed result or just the rows based on fullResults
        return txnFullResults ? processed : processed.rows;
      }) : [];
      
      return formattedResults;
    } catch (error) {
      if (error instanceof PgError) {
        throw error; // Already formatted as a PgError
      }
      
      // Create a transaction error
      const txError = new PgError(`Failed to execute transaction on PostgreSQL HTTP proxy at ${formattedProxyUrl}: ${error instanceof Error ? error.message : String(error)}`);
      txError.sourceError = error instanceof Error ? error : undefined;
      throw txError;
    }
  };

  // Create a query function that directly executes SQL with parameters
  // This version is specifically designed to be compatible with Auth.js
  const query = async (queryText: string, params: any[] = [], options?: {
    arrayMode?: boolean;
    fullResults?: boolean;
  }): Promise<PgQueryResult> => {
    try {
      // Ensure parameters and options are validated
      if (!queryText || typeof queryText !== 'string') {
        throw new PgError('SQL query text is required and must be a string');
      }
      
      // Make sure params is always an array
      const safeParams = Array.isArray(params) ? params : [];
      
      // Override array mode and full results settings
      const queryArrayMode = options?.arrayMode ?? arrayMode;
      const queryFullResults = options?.fullResults ?? fullResults;
      
      // Clone the headers for this specific query
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Neon-Raw-Text-Output': 'true',
        'Neon-Array-Mode': String(queryArrayMode),
        // IMPORTANT: Always include Authorization header if authToken is provided
        ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {})
      };
      
      const fetchOptions: RequestInit = {
        method: 'POST',
        headers,
        body: JSON.stringify({
          sql: queryText,
          params: safeParams.map(param => encodeBuffersAsBytea(param)),
          method: 'all',
        }),
      };
      
      const response = await fetchFn(`${formattedProxyUrl}/query`, fetchOptions);

      if (!response.ok) {
        let errorData: any = { error: response.statusText };
        
        try {
          errorData = await response.json();
        } catch (parseError) {
          errorData = { 
            error: `Status ${response.status}: ${response.statusText}` 
          };
        }
        
        const pgError = new PgError(errorData.error || errorData.message || `PostgreSQL HTTP proxy error: ${response.statusText}`);
        
        for (const field of PG_ERROR_FIELDS) {
          if (errorData[field] !== undefined) {
            pgError[field] = errorData[field];
          }
        }
        
        throw pgError;
      }

      // Parse the rows from the response
      let result: any;
      try {
        result = await response.json();
      } catch (jsonError) {
        throw new PgError(`Failed to parse JSON response: ${jsonError}`);
      }
      
      // Determine command type from the query for proper result formatting
      let command = 'SELECT';
      const upperQuery = queryText.trim().toUpperCase();
      if (upperQuery.startsWith('INSERT')) command = 'INSERT';
      else if (upperQuery.startsWith('UPDATE')) command = 'UPDATE';
      else if (upperQuery.startsWith('DELETE')) command = 'DELETE';
      
      // Ensure we have a valid rows array
      let rows: any[] = [];
      if (Array.isArray(result)) {
        rows = result;
      } else if (result && Array.isArray(result.rows)) {
        rows = result.rows;
      }
      
      // Ensure we have valid fields array
      const fields = Array.isArray(result?.fields) ? result.fields : [];
      
      // Create a properly structured result that matches PostgreSQL's native format
      const structuredResult: PgQueryResult = {
        command,
        fields,
        rowCount: rows.length,
        rows,
        rowAsArray: queryArrayMode,
      };
      
      // Process with type parsers
      const processed = processQueryResult(structuredResult, typeParser, queryArrayMode);
      
      // Always return a full result object with rows
      return processed;
    } catch (error) {
      if (error instanceof PgError) {
        throw error;
      }
      
      const connError = new PgError(`Failed to connect to PostgreSQL HTTP proxy at ${formattedProxyUrl}: ${error instanceof Error ? error.message : String(error)}`);
      connError.sourceError = error instanceof Error ? error : undefined;
      throw connError;
    }
  };
  
  // Unsafe query builder - create raw SQL that won't be escaped
  const unsafe = (rawSql: string) => new UnsafeRawSql(rawSql);

  // Return the client interface that exactly matches Neon's
  return {
    execute,      // Execute method
    query,        // Direct query method used by Auth.js
    sql,          // SQL template tag
    unsafe,       // For unsafe raw SQL
    transaction,  // For transactions
    typeParser,   // Expose type parser for client-side usage
  };
}

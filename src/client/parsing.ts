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


/**
 * Parse a PostgreSQL array string into a JavaScript array
 * This handles various array types and dimensions using the appropriate element parser
 */
export function parsePostgresArray(arrayString: string, elementParser: (value: string) => any): any[] {
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
export function parseArrayItem(item: string, elementParser: (value: string) => any): any {
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
export function processQueryResult(
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

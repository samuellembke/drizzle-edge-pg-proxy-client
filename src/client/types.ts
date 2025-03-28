import type { QueryPromise } from './query-promise'; // Import from new file
import type { TypeParser } from './parsing'; // Use type-only import

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

// This is used to tag template literals in SQL queries
export type SQLTemplateTag = (strings: TemplateStringsArray, ...values: any[]) => QueryPromise<PgQueryResult>;

// Transaction query interface with support for query metadata
export interface TransactionQuery {
  text: string;
  values: unknown[];
  captureGeneratedId?: boolean; // Flag to indicate this query generates an ID that will be used in subsequent queries
}

export interface ClientOptions {
  proxyUrl: string;
  authToken?: string;
  fetch?: typeof globalThis.fetch;
  arrayMode?: boolean;
  fullResults?: boolean;
  typeParser?: TypeParser | Record<number, (value: string) => any>;
  sessionId?: string; // Optional explicit session ID, will be auto-generated if not provided
  logger?: LoggerOptions; // Add logger configuration
}

// Define Log Levels
export enum LogLevel {
  Debug = 1,
  Info = 2,
  Warn = 3,
  Error = 4,
  None = 5, // Special level to disable logging
}

// Define Logger Options
export interface LoggerOptions {
  level?: LogLevel; // Minimum level to log
  // Optional custom log function: (level: LogLevel, message: string, data?: any) => void
  logFn?: (level: LogLevel, message: string, data?: any) => void;
}

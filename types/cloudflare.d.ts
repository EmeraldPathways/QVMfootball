interface D1Response {
  success: boolean;
  meta?: Record<string, unknown>;
}

interface D1Result extends D1Response {
  results: unknown[];
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(columnName?: string): Promise<T | null>;
  run(): Promise<D1Response>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  raw<T = unknown>(): Promise<T[]>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  dump(): Promise<ArrayBuffer>;
  batch<T extends D1PreparedStatement[]>(statements: T): Promise<D1Response[]>;
  exec(query: string): Promise<D1Response>;
}

interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

declare module "cloudflare:workers" {
  export const env: {
    DB?: D1Database;
    [key: string]: unknown;
  };
}

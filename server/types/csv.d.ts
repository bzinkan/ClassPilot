declare module "csv-parse/sync" {
  export function parse(input: string, options?: Record<string, unknown>): unknown;
}

declare module "csv-stringify/sync" {
  export function stringify(input: unknown, options?: Record<string, unknown>): string;
}

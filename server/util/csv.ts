import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_ROWS = 5000;
const DEFAULT_MAX_COLUMNS = 60;

export type ParseCsvOptions = {
  requiredHeaders: string[];
  optionalHeaders?: string[];
  maxBytes?: number;
  maxRows?: number;
  maxColumns?: number;
};

const normalizeHeader = (header: string) => header.trim().toLowerCase();

const formatBytesToMb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))}MB`;

export const sanitizeCsvValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "";
  }

  const stringValue = String(value);
  if (/^[=+\-@]/.test(stringValue.trimStart())) {
    return `'${stringValue}`;
  }

  return stringValue;
};

export const parseCsv = (text: string, options: ParseCsvOptions): Record<string, string>[] => {
  if (typeof text !== "string") {
    throw new Error("CSV content must be a string");
  }

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const maxColumns = options.maxColumns ?? DEFAULT_MAX_COLUMNS;

  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new Error(`CSV exceeds maximum size of ${formatBytesToMb(maxBytes)}`);
  }

  const requiredHeaders = options.requiredHeaders.map((header) => header.trim()).filter(Boolean);
  const optionalHeaders = options.optionalHeaders?.map((header) => header.trim()).filter(Boolean) ?? [];
  const allowedHeaders = [...requiredHeaders, ...optionalHeaders];

  const allowedMap = new Map<string, string>();
  for (const header of allowedHeaders) {
    const key = normalizeHeader(header);
    if (!key) {
      continue;
    }
    allowedMap.set(key, header);
  }

  const requiredNormalized = new Set(requiredHeaders.map((header) => normalizeHeader(header)));

  const records = parse(text, {
    bom: true,
    columns: (headers: string[]) => {
      if (headers.length === 0) {
        throw new Error("CSV must include a header row");
      }

      if (headers.length > maxColumns) {
        throw new Error(`CSV exceeds maximum column count of ${maxColumns}`);
      }

      const seen = new Set<string>();
      const mapped = headers.map((header) => {
        const trimmedHeader = header.trim();
        if (!trimmedHeader) {
          throw new Error("CSV contains a blank header");
        }

        const normalized = normalizeHeader(trimmedHeader);
        if (seen.has(normalized)) {
          throw new Error(`CSV contains duplicate header: ${trimmedHeader}`);
        }
        seen.add(normalized);

        const canonical = allowedMap.get(normalized);
        if (!canonical) {
          throw new Error(`CSV contains unknown header: ${trimmedHeader}`);
        }

        return canonical;
      });

      const missingRequired = [...requiredNormalized].filter((required) => !seen.has(required));
      if (missingRequired.length > 0) {
        const missingNames = requiredHeaders.filter((header) => missingRequired.includes(normalizeHeader(header)));
        throw new Error(`CSV is missing required headers: ${missingNames.join(", ")}`);
      }

      return mapped;
    },
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  if (records.length > maxRows) {
    throw new Error(`CSV exceeds maximum row limit of ${maxRows}`);
  }

  return records.map((record) => {
    const cleaned: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) {
      cleaned[key] = typeof value === "string" ? value.trim() : String(value ?? "").trim();
    }
    return cleaned;
  });
};

export const stringifyCsv = (records: Record<string, unknown>[], columns: string[]): string => {
  const sanitized = records.map((record) => {
    const next: Record<string, string> = {};
    for (const column of columns) {
      next[column] = sanitizeCsvValue(record[column]);
    }
    return next;
  });

  return stringify(sanitized, {
    header: true,
    columns,
  });
};

import { RecordBatchReader, Type, type DataType, type Field, type RecordBatch, type Vector } from "apache-arrow";
import { UINT256_COLUMNS } from "./fields.js";
import { BloklakeError } from "./errors.js";

/**
 * Arrow → JSON, exactly like the server's `/query/json`: unsigned integers → numbers,
 * FixedSizeBinary(16) → decimal string, the uint256 columns → decimal string, every other
 * binary value → `0x` hex, lists → arrays, structs → objects, null → null. Keys are the
 * response's snake_case column names, or with `camelCase` the request's names (`block_number`
 * → `blockNumber`, nested struct keys too), which is what the client returns.
 */

/** `block_number` → `blockNumber`. Every field's request name is its column name in camelCase. */
export function camelCase(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
export function toHex(b: Uint8Array): string {
  let s = "0x";
  for (let i = 0; i < b.length; i++) s += HEX[b[i]!];
  return s;
}
export function toDecimal(b: Uint8Array): string {
  if (b.length === 0) return "0";
  return BigInt(toHex(b)).toString();
}

type Json = null | number | string | Json[] | { [k: string]: Json };
type Conv = (v: unknown) => Json;

function converter(type: DataType, uint256: boolean, camel: boolean): Conv {
  switch (type.typeId) {
    case Type.Int:
      return (v) => (v == null ? null : typeof v === "bigint" ? Number(v) : (v as number));
    case Type.FixedSizeBinary: {
      const width = (type as unknown as { byteWidth: number }).byteWidth;
      const asDecimal = width === 16 || uint256;
      return (v) => (v == null ? null : asDecimal ? toDecimal(v as Uint8Array) : toHex(v as Uint8Array));
    }
    case Type.Binary:
    case Type.LargeBinary:
      return (v) => (v == null ? null : toHex(v as Uint8Array));
    case Type.List: {
      // nested values follow the generic rules (no uint256 inside lists)
      const item = converter((type.children[0] as Field).type, false, camel);
      return (v) => {
        if (v == null) return null;
        const vec = v as Vector;
        const out: Json[] = new Array(vec.length);
        for (let i = 0; i < vec.length; i++) out[i] = item(vec.get(i));
        return out;
      };
    }
    case Type.Struct: {
      const fields = (type.children as Field[]).map((f) => [f.name, camel ? camelCase(f.name) : f.name, converter(f.type, false, camel)] as const);
      return (v) => {
        if (v == null) return null;
        const row = v as Record<string, unknown>;
        const o: { [k: string]: Json } = {};
        for (const [name, key, conv] of fields) o[key] = conv(row[name]);
        return o;
      };
    }
    default:
      throw new BloklakeError(0, "unsupported_type", `unsupported Arrow type ${String(type)} in response`);
  }
}

function batchRows(batch: RecordBatch, rowType: string, camel: boolean, out: Record<string, Json>[]): void {
  const wide = UINT256_COLUMNS[rowType];
  const cols = batch.schema.fields.map((f, j) => ({
    name: camel ? camelCase(f.name) : f.name,
    vec: batch.getChildAt(j)!,
    conv: converter(f.type, wide?.has(f.name) ?? false, camel),
  }));
  for (let i = 0; i < batch.numRows; i++) {
    const row: Record<string, Json> = {};
    for (const c of cols) row[c.name] = c.conv(c.vec.get(i));
    out.push(row);
  }
}

export interface Decoded {
  rows: Record<string, Record<string, Json>[]>;
  meta: Map<string, string>;
}

/**
 * Decode a `/query` body: one Arrow IPC stream per row type, back to back. Fails with
 * `truncated` if streams are missing or fewer rows arrived than `bl.objects` announced.
 */
async function* chunks(body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | Uint8Array): AsyncIterable<Uint8Array> {
  if (body instanceof Uint8Array) yield body;
  else yield* body as AsyncIterable<Uint8Array>; // Node's and Bun's ReadableStream are async-iterable
}

export interface DecodeOptions {
  /** Key rows by the request's camelCase names instead of the response's column names. Default false. */
  camelCase?: boolean;
}

export async function decodeArrow(
  body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | Uint8Array,
  opts: DecodeOptions = {},
): Promise<Decoded> {
  const camel = opts.camelCase ?? false;
  const rows: Decoded["rows"] = {};
  let meta = new Map<string, string>();
  let streams = 0;
  try {
    for await (const reader of RecordBatchReader.readAll(chunks(body))) {
      meta = reader.schema.metadata;
      const rowType = meta.get("bl.row_type") ?? `stream${streams}`;
      const out: Record<string, Json>[] = [];
      for await (const batch of reader) batchRows(batch, rowType, camel, out);
      rows[rowType] = out;
      streams++;
    }
  } catch (e) {
    if (e instanceof BloklakeError) throw e;
    throw new BloklakeError(0, "truncated", `response ended early: ${(e as Error).message}`);
  }
  const expected = (meta.get("bl.streams") ?? "").split(",").filter(Boolean).length;
  if (streams !== expected) throw new BloklakeError(0, "truncated", `got ${streams} of ${expected} streams`);
  const received = Object.values(rows).reduce((n, r) => n + r.length, 0);
  if (received !== Number(meta.get("bl.objects"))) {
    throw new BloklakeError(0, "truncated", `got ${received} of ${meta.get("bl.objects")} rows`);
  }
  return { rows, meta };
}

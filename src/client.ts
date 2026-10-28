import type { BlockField, LogField, TransactionField } from "./fields.js";
import type { Account, ChainStatus, Hex, Page, PageMeta, Query, Schema, SetInfo } from "./types.js";
import { BloklakeError } from "./errors.js";
import { decodeArrow } from "./decode.js";

export interface ClientOptions {
  /** API key (`bl_live_…`). Defaults to the `BLOKLAKE_API_KEY` environment variable. */
  apiKey?: string;
  /** Chain name in URLs: `"eth"`, `"rh"`. Ignored when `baseUrl` is set. */
  chain?: string;
  /** Full base URL of one chain, e.g. `https://api.bloklake.com/v1/chains/eth`. */
  baseUrl?: string;
  /** Retries for rate limits (429), busy servers (503), 5xx and broken connections. Default 4. */
  maxRetries?: number;
  /** Per-request timeout in milliseconds. Default 120000. */
  timeoutMs?: number;
  /** Custom fetch (tests, proxies). Default: global `fetch`. */
  fetch?: typeof fetch;
}

export interface PaginateOptions {
  /** After the first page, send the prepared-query id instead of the whole filter. Default true. */
  usePreparedQuery?: boolean;
}

const VERSION = "0.1.0";

/** Turn typed field lists into the API's `{name: true}` objects. */
function wireBody(q: Query<LogField, TransactionField, BlockField> | Record<string, unknown>): Record<string, unknown> {
  const { fields, ...rest } = q as Query & Record<string, unknown>;
  const body: Record<string, unknown> = { ...rest };
  if (fields) {
    const f: Record<string, Record<string, true>> = {};
    for (const [rt, names] of Object.entries(fields)) {
      if (names?.length) f[rt] = Object.fromEntries((names as readonly string[]).map((n) => [n, true]));
    }
    body.fields = f;
  }
  return body;
}

function pageMeta(m: Map<string, string>): PageMeta {
  const num = (k: string) => (m.has(k) && m.get(k) !== "" ? Number(m.get(k)) : null);
  return {
    fromBlock: num("bl.from_block")!,
    toBlock: num("bl.to_block")!,
    nextBlock: num("bl.next_block")!,
    objects: num("bl.objects")!,
    archiveHeight: num("bl.archive_height")!,
    finalizedBlock: num("bl.finalized_block"),
    toBlockHash: m.get("bl.to_block_hash") || null,
    queryId: m.get("bl.query_id_template") ?? "",
    unavailableFields: (m.get("bl.unavailable_fields") ?? "").split(",").filter(Boolean),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A Bloklake client for one chain. Queries travel as Apache Arrow and are decoded here into
 * plain JSON rows: the same values `/query/json` would give, keyed by the same camelCase names
 * you select in `fields` (`blockNumber`, not the response's `block_number`).
 *
 * ```ts
 * const bl = new Bloklake({ apiKey: process.env.BLOKLAKE_API_KEY, chain: "eth" });
 * for await (const page of bl.paginate({ fromBlock: 19_000_000, toBlock: 19_100_000,
 *   logs: [{ address: [USDC], topic0: [TRANSFER] }],
 *   fields: { log: ["blockNumber", "topic1", "topic2", "data"] } })) {
 *   for (const log of page.logs) console.log(log.blockNumber, log.data);
 * }
 * ```
 */
export class Bloklake {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(opts: ClientOptions = {}) {
    if (!opts.baseUrl && !opts.chain) throw new Error("Bloklake: pass `chain` (\"eth\", \"rh\") or `baseUrl`");
    this.baseUrl = (opts.baseUrl ?? `https://api.bloklake.com/v1/chains/${opts.chain}`).replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? (typeof process !== "undefined" ? process.env.BLOKLAKE_API_KEY : undefined);
    this.maxRetries = opts.maxRetries ?? 4;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.fetchFn = opts.fetch ?? fetch;
  }

  // ---- queries ---------------------------------------------------------------------------

  /** Run a query and return one page. Read `meta.nextBlock` to continue, or use `paginate`. */
  async query<const L extends LogField = never, const T extends TransactionField = never, const B extends BlockField = never>(
    q: Query<L, T, B>,
  ): Promise<Page<L, T, B>> {
    return this.queryBody(wireBody(q)) as Promise<Page<L, T, B>>;
  }

  /**
   * Every page of a query, following `nextBlock` until `toBlock` (or the chain head when
   * `toBlock` is omitted). Re-sends the full filter if a prepared-query id expired.
   */
  async *paginate<const L extends LogField = never, const T extends TransactionField = never, const B extends BlockField = never>(
    q: Query<L, T, B>,
    opts: PaginateOptions = {},
  ): AsyncGenerator<Page<L, T, B>> {
    const full = wireBody(q);
    const usePrepared = opts.usePreparedQuery ?? true;
    let from = q.fromBlock ?? 0;
    let queryId: string | null = null;
    for (;;) {
      const range = { fromBlock: from, ...(q.toBlock !== undefined ? { toBlock: q.toBlock } : {}), ...(q.maxObjects !== undefined ? { maxObjects: q.maxObjects } : {}), ...(q.strictFields !== undefined ? { strictFields: q.strictFields } : {}) };
      let page: Page;
      try {
        page = await this.queryBody(queryId && usePrepared ? { queryId, ...range } : { ...full, ...range });
      } catch (e) {
        if (e instanceof BloklakeError && e.code === "unknown_query_id" && queryId) {
          queryId = null; // expired, or a server that never saw it: send the filter again
          continue;
        }
        throw e;
      }
      queryId = page.meta.queryId || null;
      yield page as Page<L, T, B>;
      const end = q.toBlock !== undefined ? Math.min(q.toBlock, page.meta.archiveHeight) : page.meta.archiveHeight;
      if (page.meta.nextBlock > end) return;
      from = page.meta.nextBlock;
    }
  }

  /** All pages of a query merged into one. Mind memory for large ranges; prefer `paginate`. */
  async collect<const L extends LogField = never, const T extends TransactionField = never, const B extends BlockField = never>(
    q: Query<L, T, B>,
  ): Promise<Page<L, T, B>> {
    let merged: Page<L, T, B> | null = null;
    for await (const page of this.paginate(q)) {
      if (!merged) merged = page;
      else {
        merged.logs.push(...page.logs);
        merged.transactions.push(...page.transactions);
        merged.blocks.push(...page.blocks);
        merged.meta = { ...page.meta, fromBlock: merged.meta.fromBlock, objects: merged.meta.objects + page.meta.objects };
      }
    }
    return merged!;
  }

  private async queryBody(body: Record<string, unknown>): Promise<Page> {
    return this.withRetries(async () => {
      const res = await this.send("POST", "/query", body);
      const { rows, meta } = await decodeArrow(res.body!, { camelCase: true });
      return {
        logs: (rows.logs ?? []) as never[],
        transactions: (rows.transactions ?? []) as never[],
        blocks: (rows.blocks ?? []) as never[],
        meta: pageMeta(meta),
      };
    });
  }

  // ---- sets and prepared queries -------------------------------------------------------------

  /** Store a list of addresses (20 bytes) or topics (32 bytes). Idempotent: same values, same id. */
  async createSet(set: { kind: "address" | "topic"; values: readonly Hex[]; basedOn?: Hex }): Promise<{ setId: Hex; size: number; created: boolean }> {
    const j = await this.json<{ set_id: Hex; size: number; created: boolean }>("POST", "/v1/sets", set);
    return { setId: j.set_id, size: j.size, created: j.created };
  }

  async getSet(setId: Hex): Promise<SetInfo> {
    const j = await this.json<{ set_id: Hex; kind: "address" | "topic"; size: number; created_at: number; last_used_at: number }>("GET", `/v1/sets/${setId}`);
    return { setId: j.set_id, kind: j.kind, size: j.size, createdAt: j.created_at, lastUsedAt: j.last_used_at };
  }

  async deleteSet(setId: Hex): Promise<void> {
    await this.withRetries(() => this.send("DELETE", `/v1/sets/${setId}`));
  }

  /** Register a query's filter and get its id without running it. */
  async prepare(q: Omit<Query, "fromBlock" | "toBlock" | "maxObjects">): Promise<{ queryId: Hex; expiresIn: number }> {
    const j = await this.json<{ query_id: Hex; expires_in: number }>("POST", "/v1/queries", wireBody(q as Query));
    return { queryId: j.query_id, expiresIn: j.expires_in };
  }

  // ---- chain and account ---------------------------------------------------------------------

  /** The block range served and the finalized block. Free. */
  async status(): Promise<ChainStatus> {
    const j = await this.json<{ chain_id: number; first_block: number | null; archive_height: number | null; finalized_block: number | null }>("GET", "/status");
    return { chainId: j.chain_id, firstBlock: j.first_block, archiveHeight: j.archive_height, finalizedBlock: j.finalized_block };
  }

  /** Every field and whether this chain has it. Free. */
  async schema(): Promise<Schema> {
    return this.json<Schema>("GET", "/v1/schema");
  }

  /** The key's plan, limits and balance or usage. Free and not rate limited. */
  async account(): Promise<Account> {
    const j = await this.json<{
      key_id: string; project_id: string; plan: Account["plan"]; status: Account["status"]; rps: number;
      balance_micro: number | null; bytes_used: number | null; quota_bytes: number | null;
      usage_period: string | null; blocked_for_secs: number | null;
    }>("GET", "/v1/account");
    return {
      keyId: j.key_id, projectId: j.project_id, plan: j.plan, status: j.status, rps: j.rps,
      balanceMicro: j.balance_micro, bytesUsed: j.bytes_used, quotaBytes: j.quota_bytes,
      usagePeriod: j.usage_period, blockedForSecs: j.blocked_for_secs,
    };
  }

  // ---- transport -----------------------------------------------------------------------------

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.withRetries(async () => (await this.send(method, path, body)).json() as Promise<T>);
  }

  private async send(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { "user-agent": `bloklake-node/${VERSION}` };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchFn(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const timeout = (e as Error).name === "TimeoutError";
      throw new BloklakeError(0, timeout ? "timeout" : "network", (e as Error).message);
    }
    if (!res.ok) {
      const requestId = res.headers.get("x-request-id") ?? undefined;
      const ra = res.headers.get("retry-after");
      let code = "http_error", message = res.statusText;
      try {
        const j = (await res.json()) as { error?: { code?: string; message?: string } };
        code = j.error?.code ?? code;
        message = j.error?.message ?? message;
      } catch { /* not JSON */ }
      throw new BloklakeError(res.status, code, message, ra ? Number(ra) : undefined, requestId);
    }
    return res;
  }

  private async withRetries<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof BloklakeError) || !e.retryable || attempt >= this.maxRetries) throw e;
        const wait = e.retryAfter !== undefined ? e.retryAfter * 1000 : Math.min(1000 * 2 ** attempt, 30_000) * (0.5 + Math.random() / 2);
        await sleep(wait);
      }
    }
  }
}

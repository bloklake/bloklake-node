// Client behavior with a stubbed fetch: request shape, errors, retries, pagination.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Bloklake, BloklakeError } from "../dist/index.js";

const arrow = (name) => readFileSync(new URL(`./fixtures/${name}.arrows`, import.meta.url));
const ok = (body, headers = {}) => new Response(body, { status: 200, headers });
const err = (status, code, headers = {}) =>
  new Response(JSON.stringify({ error: { code, message: code } }), { status, headers: { "content-type": "application/json", ...headers } });

function stub(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const r = responses.shift();
    if (!r) throw new Error("unexpected request");
    return typeof r === "function" ? r() : r;
  };
  return { fetch, calls };
}

test("query: typed fields become {name: true}, key and base URL are used, rows are JSON", async () => {
  const { fetch, calls } = stub([ok(arrow("eth-logs-only"))]);
  const bl = new Bloklake({ apiKey: "bl_live_test", chain: "eth", fetch });
  const page = await bl.query({
    fromBlock: 19426000, toBlock: 19426009,
    logs: [{ address: ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"] }],
    fields: { log: ["blockNumber", "logIndex", "data", "topics"] },
  });
  assert.equal(calls[0].url, "https://api.bloklake.com/v1/chains/eth/query");
  assert.equal(calls[0].headers.authorization, "Bearer bl_live_test");
  assert.deepEqual(calls[0].body.fields, { log: { blockNumber: true, logIndex: true, data: true, topics: true } });
  assert.equal(page.logs.length, 85);
  assert.equal(page.transactions.length, 0);
  assert.equal(page.meta.nextBlock, 19426010);
  assert.equal(page.meta.objects, 85);
  assert.match(page.meta.queryId, /^0x[0-9a-f]{64}$/);
  assert.equal(typeof page.logs[0].blockNumber, "number");
  assert.equal(page.logs[0].block_number, undefined);
});

test("rows are keyed by the request's camelCase names, nested struct keys too", async () => {
  const { fetch } = stub([ok(arrow("eth-all-fields"))]);
  const bl = new Bloklake({ baseUrl: "http://x", fetch });
  const page = await bl.query({ fields: { transaction: ["hash", "accessList", "maxFeePerGas"], block: ["number", "withdrawals"] }, transactions: [{}] });
  const tx = page.transactions.find((t) => t.accessList?.length);
  assert.ok(tx && "maxFeePerGas" in tx && Array.isArray(tx.accessList[0].storageKeys));
  const withdrawal = page.blocks.flatMap((b) => b.withdrawals ?? [])[0];
  assert.equal(typeof withdrawal.validatorIndex, "number");
  for (const row of [...page.transactions, ...page.blocks]) {
    for (const k of Object.keys(row)) assert.ok(!k.includes("_"), `snake_case key ${k}`);
  }
});

test("API errors carry status, code and request id; 4xx is not retried", async () => {
  const { fetch, calls } = stub([err(400, "invalid_query", { "x-request-id": "req-1" })]);
  const bl = new Bloklake({ baseUrl: "http://x/v1/chains/eth", fetch });
  await assert.rejects(bl.query({ fields: { block: ["number"] } }), (e) =>
    e instanceof BloklakeError && e.status === 400 && e.code === "invalid_query" && e.requestId === "req-1" && !e.retryable);
  assert.equal(calls.length, 1);
});

test("429 and 503 are retried after Retry-After", async () => {
  const { fetch, calls } = stub([err(429, "rate_limited", { "retry-after": "0" }), err(503, "unavailable", { "retry-after": "0" }), ok(arrow("eth-empty"))]);
  const bl = new Bloklake({ baseUrl: "http://x", fetch });
  const page = await bl.query({ fields: { log: ["blockNumber"] }, logs: [{}] });
  assert.equal(calls.length, 3);
  assert.equal(page.logs.length, 0);
});

test("a truncated body is retried", async () => {
  const full = arrow("eth-logs-only");
  const { fetch, calls } = stub([ok(full.subarray(0, 3000)), ok(full)]);
  const bl = new Bloklake({ baseUrl: "http://x", fetch, maxRetries: 1 });
  const page = await bl.query({ fields: { log: ["blockNumber"] }, logs: [{}] });
  assert.equal(calls.length, 2);
  assert.equal(page.logs.length, 85);
});

test("retries stop after maxRetries", async () => {
  const { fetch, calls } = stub([err(500, "internal"), err(500, "internal")]);
  const bl = new Bloklake({ baseUrl: "http://x", fetch, maxRetries: 1 });
  await assert.rejects(bl.status(), (e) => e.status === 500);
  assert.equal(calls.length, 2);
});

test("status, account and sets map the API's JSON", async () => {
  const j = (o) => ok(JSON.stringify(o), { "content-type": "application/json" });
  const { fetch, calls } = stub([
    j({ chain_id: 1, first_block: 0, archive_height: 100, finalized_block: 90 }),
    j({ set_id: "0xab", size: 2, created: true }),
    () => new Response(null, { status: 204 }),
  ]);
  const bl = new Bloklake({ baseUrl: "http://x", fetch });
  assert.deepEqual(await bl.status(), { chainId: 1, firstBlock: 0, archiveHeight: 100, finalizedBlock: 90 });
  assert.deepEqual(await bl.createSet({ kind: "address", values: ["0x01"] }), { setId: "0xab", size: 2, created: true });
  await bl.deleteSet("0xab");
  assert.equal(calls[2].method, "DELETE");
  assert.equal(calls[2].url, "http://x/v1/sets/0xab");
});

test("constructor needs a chain or a base URL", () => {
  assert.throws(() => new Bloklake({}), /chain/);
});

test("paginate: strictFields goes with the full query and with every queryId page", async () => {
  const { fetch, calls } = stub([ok(arrow("eth-logs-only")), ok(arrow("eth-logs-only"))]);
  const bl = new Bloklake({ baseUrl: "http://x", fetch });
  const pages = bl.paginate({ fromBlock: 19426000, toBlock: 19426019, strictFields: true, logs: [{}], fields: { log: ["blockNumber"] } });
  for (let i = 0; i < 2; i++) await pages.next();
  assert.equal(calls[0].body.strictFields, true);
  assert.deepEqual(calls[1].body.fields, undefined);
  assert.match(calls[1].body.queryId, /^0x[0-9a-f]{64}$/);
  assert.equal(calls[1].body.strictFields, true);
});

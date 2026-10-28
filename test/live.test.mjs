// Against a real server: BLOKLAKE_TEST_URL=https://api.bloklake.com/v1/chains/eth BLOKLAKE_API_KEY=… npm test
// Skipped when BLOKLAKE_TEST_URL is unset. Uses Ethereum blocks 19426000..19427499.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bloklake } from "../dist/index.js";

const url = process.env.BLOKLAKE_TEST_URL;
const opts = { skip: !url && "set BLOKLAKE_TEST_URL to run" };
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

async function serverJson(body) {
  const r = await fetch(`${url}/query/json`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(process.env.BLOKLAKE_API_KEY ? { authorization: `Bearer ${process.env.BLOKLAKE_API_KEY}` } : {}) },
    body: JSON.stringify(body),
  });
  return r.json();
}

test("query matches /query/json for every field", opts, async () => {
  const bl = new Bloklake({ baseUrl: url });
  const schema = await bl.schema();
  const all = (rt) => schema.row_types[rt].map((f) => f.dsl_name);
  const q = { fromBlock: 19426597, toBlock: 19426597, transactions: [{}], logs: [{ address: [USDC] }],
    fields: { transaction: all("transactions"), log: all("logs"), block: all("blocks") } };
  const page = await bl.query(q);
  const expected = await serverJson({ ...q, fields: Object.fromEntries(Object.entries(q.fields).map(([k, v]) => [k, Object.fromEntries(v.map((n) => [n, true]))])) });
  assert.deepStrictEqual(page.transactions, expected.transactions);
  assert.deepStrictEqual(page.logs, expected.logs);
  assert.deepStrictEqual(page.blocks, expected.blocks);
  assert.deepStrictEqual(page.meta.unavailableFields, expected.unavailable_fields);
});

test("paginate covers the range exactly once and reuses the prepared query", opts, async () => {
  const bodies = [];
  const spy = (u, init) => { if (String(u).endsWith("/query")) bodies.push(JSON.parse(init.body)); return fetch(u, init); };
  const bl = new Bloklake({ baseUrl: url, fetch: spy });
  const q = { fromBlock: 19426000, toBlock: 19427499, maxObjects: 2000, logs: [{ topic0: [TRANSFER], address: [USDC] }],
    fields: { log: ["blockNumber", "logIndex"] } };
  let expectFrom = 19426000, rows = 0, pages = 0;
  for await (const page of bl.paginate(q)) {
    assert.equal(page.meta.fromBlock, expectFrom);
    expectFrom = page.meta.nextBlock;
    rows += page.logs.length;
    pages++;
  }
  assert.equal(expectFrom, 19427500);
  assert.ok(bodies.slice(1).every((b) => b.queryId && !b.logs), "pages after the first send only the id");
  const all = await bl.collect({ ...q, maxObjects: undefined });
  assert.equal(all.logs.length, rows);
  assert.ok(pages > 5, `${pages} pages`);
});

test("an expired prepared query is resent in full", opts, async () => {
  let n = 0;
  const flaky = async (u, init) => {
    const body = JSON.parse(init.body ?? "{}");
    if (body.queryId && n++ === 0) {
      return new Response(JSON.stringify({ error: { code: "unknown_query_id", message: "expired" } }), { status: 400 });
    }
    return fetch(u, init);
  };
  const bl = new Bloklake({ baseUrl: url, fetch: flaky });
  const all = await bl.collect({ fromBlock: 19426000, toBlock: 19426999, maxObjects: 5000, logs: [{ topic0: [TRANSFER] }], fields: { log: ["logIndex"] } });
  assert.ok(all.logs.length > 5000);
});

test("status reports the served range", opts, async () => {
  const s = await new Bloklake({ baseUrl: url }).status();
  assert.ok(s.firstBlock <= 19426000 && s.archiveHeight >= 19427499);
});

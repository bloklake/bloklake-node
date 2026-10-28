// Arrow → JSON conformance: decoding a recorded /query response must give exactly what the
// server's /query/json returned for the same request (recorded alongside it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeArrow, BloklakeError } from "../dist/index.js";

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const json = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

for (const name of ["eth-all-fields", "rh-all-fields", "eth-logs-only", "eth-empty", "synthetic-u256"]) {
  test(`${name}: rows equal the server's /query/json`, async () => {
    const { rows, meta } = await decodeArrow(fixture(`${name}.arrows`));
    const expected = json(`${name}.json`);
    for (const rt of ["transactions", "logs", "blocks"]) {
      if (expected[rt] !== undefined) assert.deepStrictEqual(rows[rt], expected[rt], rt);
      else assert.equal(rows[rt], undefined, rt);
    }
    assert.equal(Number(meta.get("bl.objects")), expected.objects);
    assert.equal(Number(meta.get("bl.next_block")), expected.next_block);
  });
}

test("every Arrow type in the schema appears in the all-fields fixtures", async () => {
  const eth = await decodeArrow(fixture("eth-all-fields.arrows"));
  const tx = eth.rows.transactions.find((t) => t.type === 3);
  assert.ok(tx.blob_versioned_hashes.length > 0 && tx.blob_versioned_hashes[0].startsWith("0x"));
  assert.match(tx.value, /^\d+$/);
  assert.ok(eth.rows.transactions.some((t) => t.access_list?.length && t.access_list[0].storage_keys));
  assert.equal(typeof eth.rows.blocks[0].withdrawals[0].amount, "number");
});

test("uint256 columns are decimal strings; 32-byte values inside structs stay hex", async () => {
  const { rows } = await decodeArrow(fixture("synthetic-u256.arrows"));
  const [a, b, c] = rows.transactions;
  assert.equal(a.max_refund, (2n ** 256n - 1n).toString());
  assert.equal(b.deposit_value, (2n ** 200n).toString());
  assert.equal(c.deposit_value, "0");
  assert.equal(a.authorization_list[0].chain_id, "0x" + "00".repeat(31) + "01");
  assert.equal(c.max_refund, null);
});

test("a body cut mid-batch is a truncated error, not a short result", async () => {
  const bytes = fixture("eth-all-fields.arrows");
  await assert.rejects(decodeArrow(bytes.slice(0, Math.floor(bytes.length / 2))), (e) => e instanceof BloklakeError && e.code === "truncated");
});

test("fewer rows than bl.objects announced is a truncated error", async () => {
  await assert.rejects(decodeArrow(fixture("synthetic-short.arrows")), (e) => e.code === "truncated" && /3 of 5/.test(e.message));
});

test("decoding works from a chunked stream", async () => {
  const bytes = fixture("rh-all-fields.arrows");
  const stream = new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += 1000) c.enqueue(bytes.slice(i, i + 1000));
      c.close();
    },
  });
  const { rows } = await decodeArrow(stream);
  assert.deepStrictEqual(rows.logs, json("rh-all-fields.json").logs);
});

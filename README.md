# @bloklake/client

The official Node.js and TypeScript client for the [Bloklake](https://docs.bloklake.com) API.

- **Typed queries**: filters and field names are checked by TypeScript, and each result row is
  typed with exactly the fields you selected.
- **Arrow on the wire, JSON in your code**: responses travel as Apache Arrow (about 2–2.5×
  smaller than JSON, so cheaper) and are decoded here into plain objects with the same values
  `/query/json` returns.
- **Pagination, retries and integrity built in**: follows `next_block`, reuses prepared
  queries, retries rate limits and busy servers, and refuses truncated responses.

```bash
npm install @bloklake/client
```

Node 18+, Bun and Deno.

## Quick start

```ts
import { Bloklake } from "@bloklake/client";

const bl = new Bloklake({ chain: "eth" }); // API key from BLOKLAKE_API_KEY

const page = await bl.query({
  fromBlock: 19_426_000,
  toBlock: 19_426_009,
  logs: [{
    address: ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"],
    topic0: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"],
  }],
  fields: { log: ["blockNumber", "transactionHash", "topic1", "topic2", "data"] },
});

for (const log of page.logs) {
  log.blockNumber;  // number: rows use the names you selected
  log.data;         // "0x…"
  // log.address    // compile error: not selected
}
console.log(page.meta.nextBlock);
```

## Reading a whole range

`paginate` follows `nextBlock` until `toBlock` (or the chain head when you leave `toBlock`
out). After the first page it sends only the prepared-query id, and falls back to the full
query if the id expired.

```ts
for await (const page of bl.paginate({
  fromBlock: 19_000_000,
  toBlock: 19_100_000,
  logs: [{ topic0: [TRANSFER] }],
  fields: { log: ["blockNumber", "address", "topic1", "topic2", "data"] },
})) {
  await store(page.logs);
}
```

`collect(query)` returns all pages merged into one `Page`. Use it for ranges that fit in memory.

## Results

A `Page` has `logs`, `transactions` and `blocks` arrays (empty when not requested) and `meta`:

| `meta` | |
|---|---|
| `fromBlock`, `toBlock` | the blocks this page covers |
| `nextBlock` | where the next page starts |
| `objects` | rows in this page |
| `archiveHeight`, `finalizedBlock` | the chain head and the newest final block at query time |
| `toBlockHash` | hash of `toBlock` when it isn't final yet (compare it to detect reorgs) |
| `queryId` | the prepared-query id |
| `unavailableFields` | selected fields this chain doesn't have |

Rows are keyed by the same camelCase names you select in `fields` (`blockNumber`,
`transactionHash`; nested objects too, e.g. `accessList[0].storageKeys`), with the API's JSON
encoding. The raw HTTP API (`/query/json`, the Arrow column names) uses snake_case
(`block_number`): `decodeArrow(body)` returns those keys, `decodeArrow(body, { camelCase: true })`
the client's.

| Field kind | Value |
|---|---|
| block numbers, indexes, gas, timestamps | `number` |
| amounts (`value`, gas prices, fees, uint256) | decimal `string` (`BigInt(x)` to compute) |
| hashes, addresses, topics, `input`, `data` | `0x` hex `string` |
| `withdrawals`, `accessList`, `authorizationList` | arrays of objects |
| not available or not applicable | `null` |

## Other calls

```ts
const { setId } = await bl.createSet({ kind: "address", values: pools }); // idempotent
await bl.query({ logs: [{ addressSet: setId, topic0: [SWAP] }], fields: { log: ["address", "data"] } });
await bl.getSet(setId);
await bl.deleteSet(setId);

await bl.prepare({ logs: [{ topic0: [TRANSFER] }], fields: { log: ["data"] } }); // { queryId, expiresIn }
await bl.status();  // { chainId, firstBlock, archiveHeight, finalizedBlock } (free)
await bl.schema();  // every field and whether this chain has it (free)
await bl.account(); // plan, rps, balance or usage (free)
```

## Errors

Failures throw `BloklakeError` with `status` (0 for client-side failures), `code`
(`invalid_query`, `rate_limited`, `balance_exhausted`, `truncated`, …), `retryAfter` and
`requestId`. The client retries `429`, `503`, `5xx`, network errors and truncated responses
itself, up to `maxRetries` (default 4), honoring `Retry-After`. Other errors need a fix and
are thrown at once. See [Errors](https://docs.bloklake.com/api-reference/errors).

```ts
try {
  await bl.query(q);
} catch (e) {
  if (e instanceof BloklakeError && e.code === "balance_exhausted") alertSomeone();
  else throw e;
}
```

## Options

```ts
new Bloklake({
  apiKey: "bl_live_…",          // default: process.env.BLOKLAKE_API_KEY
  chain: "rh",                  // or baseUrl: "https://api.bloklake.com/v1/chains/rh"
  maxRetries: 4,
  timeoutMs: 120_000,
  fetch: customFetch,           // proxies, tests
});
```

Keep your key on the server: the API doesn't allow browser calls, and a key in a browser is public.

## Development

```bash
npm install
npm test            # builds, then runs the unit and fixture tests
npm run typecheck   # includes compile-time checks of the typed API (test/types.check.ts)
BLOKLAKE_TEST_URL=https://api.bloklake.com/v1/chains/eth BLOKLAKE_API_KEY=… npm test   # plus live tests
npm run generate    # regenerate src/fields.ts after updating scripts/schema.json (GET /v1/schema)
```

The fixture tests decode recorded Arrow responses and compare them with the server's own
`/query/json` output for the same requests, field by field.

## License

MIT

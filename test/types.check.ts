// Compile-only checks of the typed API (`npm run typecheck`). Lines marked @ts-expect-error
// must fail to compile; everything else must compile.
import { Bloklake, type LogRow, type Page } from "../src/index.js";

declare const bl: Bloklake;

async function narrowing() {
  const page = await bl.query({
    logs: [{ address: ["0x00"] }],
    fields: { log: ["blockNumber", "data", "topics"], block: ["number", "baseFeePerGas", "withdrawals"] },
  });
  const n: number = page.logs[0]!.blockNumber;
  const d: string = page.logs[0]!.data;
  const t3: string | null = page.logs[0]!.topic3; // "topics" selects topic0..topic3
  const fee: string | null = page.blocks[0]!.baseFeePerGas;
  const amount: number | undefined = page.blocks[0]!.withdrawals?.[0]?.amount;
  const validator: number | undefined = page.blocks[0]!.withdrawals?.[0]?.validatorIndex;
  // @ts-expect-error rows use the request's names: blockNumber, not block_number
  page.logs[0]!.block_number;
  // @ts-expect-error address was not selected
  page.logs[0]!.address;
  // @ts-expect-error no transaction fields were selected
  page.transactions[0]!.hash;
  void [n, d, t3, fee, amount, validator];
}

async function wrongNames() {
  // @ts-expect-error unknown field name
  await bl.query({ fields: { log: ["adress"] } });
  // @ts-expect-error transaction status filter is 0 or 1
  await bl.query({ transactions: [{ status: 2 }], fields: { transaction: ["hash"] } });
  // @ts-expect-error transaction type filter is a list of numbers
  await bl.query({ transactions: [{ type: ["0x2"] }], fields: { transaction: ["hash"] } });
  await bl.query({ transactions: [{ type: [3], status: 1 }], fields: { transaction: ["hash"] } });
}

async function paging() {
  for await (const page of bl.paginate({ fromBlock: 1, fields: { transaction: ["hash", "value"] } })) {
    const v: string = page.transactions[0]!.value; // u128: decimal string
    const p: Page<never, "hash" | "value", never> = page;
    void [v, p];
  }
  const row: LogRow<"address"> = { address: "0x" };
  void row;
}
void [narrowing, wrongNames, paging];

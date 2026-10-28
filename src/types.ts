import type { BlockField, BlockFieldTypes, LogField, LogFieldTypes, TransactionField, TransactionFieldTypes } from "./fields.js";

/** `0x`-prefixed hex string. */
export type Hex = string;

/** Matches logs. Every key set must match (AND); a row matches if any filter in the list does (OR). */
export interface LogFilter {
  /** Contracts that emitted the log (20-byte hex). */
  address?: readonly Hex[];
  /** Event selectors (32-byte hex). */
  topic0?: readonly Hex[];
  /** First indexed argument (32-byte hex; addresses left-padded with zeros). */
  topic1?: readonly Hex[];
  topic2?: readonly Hex[];
  topic3?: readonly Hex[];
  /** Server-side sets (see `createSet`), combined with the literal list of the same field. */
  addressSet?: string;
  topic0Set?: string;
  topic1Set?: string;
  topic2Set?: string;
  topic3Set?: string;
}

/** Matches transactions. Every key set must match (AND); a row matches if any filter does (OR). */
export interface TransactionFilter {
  from?: readonly Hex[];
  to?: readonly Hex[];
  /** Function selectors: the first 4 bytes of `input`. */
  sighash?: readonly Hex[];
  fromSet?: string;
  toSet?: string;
  /** Keep only succeeded (1) or reverted (0) transactions; the same on every filter. */
  status?: 0 | 1;
  /** Transaction types: 0 legacy, 1 access list, 2 EIP-1559, 3 blob, 4 EIP-7702, and chain-specific types (Arbitrum 100–120). */
  type?: readonly number[];
}

/** Which columns to return, by request (camelCase) name. */
export interface Fields<L extends LogField = LogField, T extends TransactionField = TransactionField, B extends BlockField = BlockField> {
  log?: readonly L[];
  transaction?: readonly T[];
  block?: readonly B[];
}

/** A query. See https://docs.bloklake.com/querying/request-body */
export interface Query<L extends LogField = LogField, T extends TransactionField = TransactionField, B extends BlockField = BlockField> {
  /** First block, inclusive. Default 0. */
  fromBlock?: number;
  /** Last block, inclusive. Default and maximum: the chain head. */
  toBlock?: number;
  /** Target rows per page (default and maximum 100,000). A page never splits a block. */
  maxObjects?: number;
  logs?: readonly LogFilter[];
  transactions?: readonly TransactionFilter[];
  /** Also return the transaction of every matched log. */
  joinTransactions?: boolean;
  /** Keep every n-th block in the blocks stream. */
  blockInterval?: number;
  blockOffset?: number;
  /** Reject (400) a selected field this chain doesn't have, instead of returning it as an all-null column. */
  strictFields?: boolean;
  fields: Fields<L, T, B>;
}

type ExpandTopics<F> = F extends "topics" ? "topic0" | "topic1" | "topic2" | "topic3" : F;
type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** A log row with exactly the selected fields, keyed by the names you selected (`blockNumber`). */
export type LogRow<F extends LogField = LogField> = Simplify<{
  [K in Exclude<ExpandTopics<F>, "topics">]: LogFieldTypes[K];
}>;
/** A transaction row with exactly the selected fields. */
export type TransactionRow<F extends TransactionField = TransactionField> = Simplify<{
  [K in F]: TransactionFieldTypes[K];
}>;
/** A block row with exactly the selected fields. */
export type BlockRow<F extends BlockField = BlockField> = Simplify<{
  [K in F]: BlockFieldTypes[K];
}>;

/** What a response says about itself. */
export interface PageMeta {
  /** First block this page covers. */
  fromBlock: number;
  /** Last block this page covers (after clamping to the head and pagination). */
  toBlock: number;
  /** `fromBlock` for the next page. */
  nextBlock: number;
  /** Rows in this page, across row types. */
  objects: number;
  /** The chain head at query time. */
  archiveHeight: number;
  /** The newest final block at query time; rows at or below it never change. */
  finalizedBlock: number | null;
  /** Hash of `toBlock` when it is above `finalizedBlock` (compare it to detect reorgs). */
  toBlockHash: Hex | null;
  /** Prepared-query id of this query's filter. */
  queryId: Hex;
  /** Selected fields this chain doesn't have, as `<row type>.<column>`. */
  unavailableFields: string[];
}

/** One response: the rows of each row type and the response metadata. */
export interface Page<L extends LogField = LogField, T extends TransactionField = TransactionField, B extends BlockField = BlockField> {
  logs: LogRow<L>[];
  transactions: TransactionRow<T>[];
  blocks: BlockRow<B>[];
  meta: PageMeta;
}

export interface ChainStatus {
  chainId: number;
  /** Lowest block served. */
  firstBlock: number | null;
  /** Newest block served. */
  archiveHeight: number | null;
  finalizedBlock: number | null;
}

export interface Account {
  keyId: string;
  projectId: string;
  plan: "payg" | "standard" | "custom";
  status: "active" | "suspended" | "revoked";
  rps: number;
  /** Pay-as-you-go balance in millionths of a dollar; `null` on a subscription. */
  balanceMicro: number | null;
  /** Subscription: data billed this period; `null` on pay-as-you-go. */
  bytesUsed: number | null;
  /** Subscription: the most the project may use this period. */
  quotaBytes: number | null;
  usagePeriod: string | null;
  blockedForSecs: number | null;
}

export interface SetInfo {
  setId: Hex;
  kind: "address" | "topic";
  size: number;
  createdAt: number;
  lastUsedAt: number;
}

export interface SchemaField {
  name: string;
  dsl_name: string;
  arrow_type: string;
  nullable: boolean;
  family: "base" | "arbitrum" | "op_stack";
  available: boolean;
}

export interface Schema {
  families: string[] | null;
  row_types: { transactions: SchemaField[]; logs: SchemaField[]; blocks: SchemaField[] };
}

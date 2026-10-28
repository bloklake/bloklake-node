/**
 * An API error (`status` > 0, `code` from the response body) or a client-side failure
 * (`status` 0: `truncated`, `network`, `timeout`).
 * Codes: https://docs.bloklake.com/api-reference/errors
 */
export class BloklakeError extends Error {
  override readonly name = "BloklakeError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Seconds from `Retry-After`, when the server sent it. */
    readonly retryAfter?: number,
    /** `X-Request-Id` of the response: quote it to support. */
    readonly requestId?: string,
  ) {
    super(`${status ? `${status} ` : ""}${code}: ${message}`);
  }

  /** Worth retrying as is: rate limits, busy or failing servers, broken connections. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500 || ["truncated", "network", "timeout"].includes(this.code);
  }
}

import { splitIntoWindows } from "@/lib/clover/windows";

// Read-only Clover REST client for a single merchant with a private API token.
// Only GET is exposed on purpose: nothing in this app writes to Clover.

/** Clover objects are kept loose: field semantics are confirmed from live data by the probe. */
export type CloverObject = { id: string; [key: string]: unknown };

type Page = { elements?: CloverObject[] };

export class CloverApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message);
    this.name = "CloverApiError";
  }
}

export type CloverClientOptions = {
  baseUrl: string;
  merchantId: string;
  token: string;
  /** Elements per request. Clover default is 100, max 1000. */
  pageSize?: number;
  /** Retries after the first attempt for 429/502/503/504. */
  maxRetries?: number;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export type Query = Record<string, string | number | readonly string[] | undefined>;

const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_PAGE_SIZE = 1000;
const MAX_BACKOFF_MS = 30_000;

export class CloverClient {
  private readonly base: string;
  private readonly merchantId: string;
  private readonly token: string;
  private readonly pageSize: number;
  private readonly maxRetries: number;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: CloverClientOptions) {
    const base = new URL(opts.baseUrl);
    if (base.protocol !== "https:") throw new Error("CLOVER_API_BASE must be https");
    if (!opts.token) throw new Error("Clover token is empty");
    if (!opts.merchantId) throw new Error("Clover merchant id is empty");
    this.base = base.origin;
    this.merchantId = opts.merchantId;
    this.token = opts.token;
    this.pageSize = Math.min(opts.pageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
    this.maxRetries = opts.maxRetries ?? 5;
    // Clover requires: <product> / <product-version> <comment>
    this.userAgent = opts.userAgent ?? "yummy-finance / 0.1.0 (single-merchant monthly P&L)";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  static fromEnv(env: Record<string, string | undefined> = process.env): CloverClient {
    const need = (k: string) => {
      const v = env[k];
      if (!v) throw new Error(`${k} is not set`);
      return v;
    };
    return new CloverClient({
      baseUrl: env.CLOVER_API_BASE || "https://api.clover.com",
      merchantId: need("CLOVER_MERCHANT_ID"),
      token: need("CLOVER_API_TOKEN"),
    });
  }

  private url(path: string, query: Query): string {
    const u = new URL(`${this.base}/v3/merchants/${encodeURIComponent(this.merchantId)}${path}`);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      // Repeated params, e.g. filter=a&filter=b (Clover ANDs them).
      for (const item of typeof v === "object" ? v : [String(v)]) u.searchParams.append(k, item);
    }
    return u.toString();
  }

  /** GET with auth, User-Agent, and retry/backoff on 429 and transient 5xx. */
  async get<T = unknown>(path: string, query: Query = {}): Promise<T> {
    const url = this.url(path, query);
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          "User-Agent": this.userAgent,
        },
      });
      if (res.ok) return (await res.json()) as T;

      if (RETRYABLE.has(res.status) && attempt < this.maxRetries) {
        await this.sleep(this.backoffMs(res, attempt));
        continue;
      }
      // Never include the URL query or token in the message; keep a short body snippet.
      const body = (await res.text().catch(() => "")).slice(0, 200);
      throw new CloverApiError(`Clover GET ${path} failed: ${res.status} ${body}`, res.status, path);
    }
  }

  /**
   * Clover asks for >= 1s after a 429 and exponential growth if it persists;
   * concurrent-limit responses carry Retry-After, which we honor as a floor.
   */
  private backoffMs(res: Response, attempt: number): number {
    const exp = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
    const retryAfter = Number(res.headers.get("retry-after"));
    const floor = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
    return Math.max(exp, floor);
  }

  /** One page, as-is. Used by the probe for small samples. */
  async getPage(path: string, query: Query & { limit?: number; offset?: number } = {}): Promise<CloverObject[]> {
    const page = await this.get<Page>(path, query);
    return page.elements ?? [];
  }

  /** All elements, paging with limit/offset until a short page. */
  async getAll(path: string, query: Query = {}): Promise<CloverObject[]> {
    const out: CloverObject[] = [];
    for (let offset = 0; ; offset += this.pageSize) {
      const elements = await this.getPage(path, { ...query, limit: this.pageSize, offset });
      out.push(...elements);
      if (elements.length < this.pageSize) return out;
    }
  }

  /**
   * Everything created in [startMs, endMs), split into <= 89-day windows and
   * de-duplicated by id. (Windows are half-open and disjoint; the dedupe is a
   * guard against ids that move between pages while we read.)
   */
  async getAllInRange(
    path: string,
    startMs: number,
    endMs: number,
    query: Query = {},
  ): Promise<CloverObject[]> {
    const seen = new Map<string, CloverObject>();
    for (const w of splitIntoWindows(startMs, endMs)) {
      const items = await this.getAll(path, {
        ...query,
        // Clover documents >= and <=; the upper bound is made exclusive by subtracting 1ms.
        filter: [`createdTime>=${w.fromMs}`, `createdTime<=${w.toMs - 1}`],
      });
      for (const it of items) seen.set(it.id, it);
    }
    return [...seen.values()];
  }

  listPayments(startMs: number, endMs: number, expand?: string) {
    return this.getAllInRange("/payments", startMs, endMs, { expand });
  }

  listRefunds(startMs: number, endMs: number, expand?: string) {
    return this.getAllInRange("/refunds", startMs, endMs, { expand });
  }

  listOrders(startMs: number, endMs: number, expand?: string) {
    return this.getAllInRange("/orders", startMs, endMs, { expand });
  }

  getMerchant(): Promise<Record<string, unknown>> {
    return this.get("");
  }

  getMerchantProperties(): Promise<Record<string, unknown>> {
    return this.get("/properties");
  }
}

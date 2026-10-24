import assert from "node:assert/strict";
import { CloverApiError, CloverClient } from "../src/lib/clover/client";
import { aliasId, findTimezoneFields, redact, shapeOf } from "../src/lib/clover/redact";
import { splitIntoWindows } from "../src/lib/clover/windows";

const DAY = 86_400_000;
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

type Call = { url: URL; headers: Headers };
function mock(handler: (call: Call, n: number) => Response) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: new URL(String(input)), headers: new Headers(init?.headers) };
    calls.push(call);
    return handler(call, calls.length);
  }) as typeof fetch;
  const client = (extra: Partial<ConstructorParameters<typeof CloverClient>[0]> = {}) =>
    new CloverClient({
      baseUrl: "https://api.clover.com",
      merchantId: "M123",
      token: "SECRET-TOKEN",
      fetchImpl,
      sleep: async (ms) => void sleeps.push(ms),
      ...extra,
    });
  return { calls, sleeps, client };
}

async function main() {
  // --- windows
  assert.deepEqual(splitIntoWindows(0, 10 * DAY), [{ fromMs: 0, toMs: 10 * DAY }]);
  assert.deepEqual(splitIntoWindows(5, 5), []);
  const w = splitIntoWindows(0, 200 * DAY);
  assert.equal(w.length, 3);
  assert.equal(w[0].fromMs, 0);
  for (let i = 1; i < w.length; i++) assert.equal(w[i].fromMs, w[i - 1].toMs, "contiguous, no gap/overlap");
  assert.equal(w.at(-1)!.toMs, 200 * DAY);
  assert.ok(w.every((x) => x.toMs - x.fromMs <= 89 * DAY), "never exceeds 89 days");

  // --- auth, user agent, url shape
  {
    const m = mock(() => json({ elements: [] }));
    await m.client().getPage("/payments", { limit: 5, expand: "refunds" });
    const { url, headers } = m.calls[0];
    assert.equal(headers.get("authorization"), "Bearer SECRET-TOKEN");
    assert.match(headers.get("user-agent")!, /^yummy-finance \/ \S+ \(.+\)$/);
    assert.equal(url.pathname, "/v3/merchants/M123/payments");
    assert.equal(url.searchParams.get("limit"), "5");
    assert.equal(url.searchParams.get("expand"), "refunds");
  }

  // --- pagination: full pages continue, short page stops
  {
    const m = mock(({ url }) => {
      const off = Number(url.searchParams.get("offset"));
      const n = off === 0 ? 3 : off === 3 ? 3 : 1;
      return json({ elements: Array.from({ length: n }, (_, i) => ({ id: `p${off + i}` })) });
    });
    const all = await m.client({ pageSize: 3 }).getAll("/payments");
    assert.equal(all.length, 7);
    assert.deepEqual(m.calls.map((c) => c.url.searchParams.get("offset")), ["0", "3", "6"]);
    assert.ok(m.calls.every((c) => c.url.searchParams.get("limit") === "3"));
  }
  {
    // exact multiple of page size needs one extra (empty) request to know it's done
    const m = mock(({ url }) =>
      json({ elements: url.searchParams.get("offset") === "0" ? [{ id: "a" }, { id: "b" }] : [] }),
    );
    assert.equal((await m.client({ pageSize: 2 }).getAll("/payments")).length, 2);
    assert.equal(m.calls.length, 2);
  }
  {
    const m = mock(() => json({ elements: [] }));
    await m.client({ pageSize: 99_999 }).getAll("/payments");
    assert.equal(m.calls[0].url.searchParams.get("limit"), "1000", "page size capped at 1000");
  }

  // --- 429: Retry-After honored; exponential without it; recovers
  {
    const m = mock((_c, n) =>
      n === 1 ? new Response("", { status: 429, headers: { "retry-after": "7" } }) : json({ elements: [{ id: "x" }] }),
    );
    assert.equal((await m.client().getAll("/payments")).length, 1);
    assert.deepEqual(m.sleeps, [7000]);
  }
  {
    const m = mock((_c, n) => (n <= 3 ? new Response("", { status: 429 }) : json({ elements: [] })));
    await m.client().getAll("/payments");
    assert.deepEqual(m.sleeps, [1000, 2000, 4000]);
  }
  {
    const m = mock(() => new Response("slow down", { status: 429 }));
    await assert.rejects(m.client({ maxRetries: 2 }).getAll("/payments"), (e: unknown) => {
      assert.ok(e instanceof CloverApiError && e.status === 429);
      return true;
    });
    assert.equal(m.calls.length, 3, "1 try + 2 retries");
  }

  // --- non-retryable errors fail fast and never leak the token
  {
    const m = mock(() => new Response("bad token", { status: 401 }));
    await assert.rejects(m.client().getMerchant(), (e: unknown) => {
      assert.ok(e instanceof CloverApiError && e.status === 401);
      assert.ok(!String((e as Error).message).includes("SECRET-TOKEN"));
      return true;
    });
    assert.equal(m.calls.length, 1);
    assert.equal(m.sleeps.length, 0);
  }

  // --- range queries: windowed filters, dedupe across windows
  {
    const start = Date.UTC(2026, 0, 1);
    const end = start + 200 * DAY;
    const m = mock(() => json({ elements: [{ id: "dup" }, { id: `u${Math.random()}` }] }));
    const items = await m.client().listPayments(start, end);
    assert.equal(m.calls.length, 3 * 1, "one short page per window");
    assert.equal(items.filter((i) => i.id === "dup").length, 1, "de-duplicated by id");
    const filters = m.calls.map((c) => c.url.searchParams.getAll("filter"));
    assert.deepEqual(filters[0], [`createdTime>=${start}`, `createdTime<=${start + 89 * DAY - 1}`]);
    assert.equal(filters[1][0], `createdTime>=${start + 89 * DAY}`);
    assert.equal(filters[2][1], `createdTime<=${end - 1}`);
  }

  // --- config guards
  assert.throws(() => new CloverClient({ baseUrl: "http://api.clover.com", merchantId: "m", token: "t" }), /https/);
  assert.throws(() => new CloverClient({ baseUrl: "https://api.clover.com", merchantId: "m", token: "" }), /token/);
  assert.throws(() => CloverClient.fromEnv({}), /CLOVER_MERCHANT_ID/);

  // --- redaction
  {
    const sample = {
      id: "PAY123",
      amount: 1250,
      tipAmount: 200,
      taxAmount: 100,
      result: "SUCCESS",
      createdTime: 1760000000000,
      employee: { id: "E1", name: "Jane Doe" },
      cardTransaction: { last4: "4242", first6: "411111", cardholderName: "JANE DOE", cardType: "VISA", entryType: "EMV_CONTACT" },
      order: { id: "ORD9" },
      note: "for bob@example.com",
      tender: { label: "Credit Card", labelKey: "com.clover.tender.credit_card" },
      voided: false,
    };
    type Redacted = {
      amount: number; tipAmount: number; result: string; createdTime: number; voided: boolean; id: string;
      order: { id: string }; employee: unknown; cardTransaction: unknown; note: string; tender: { label: string };
    };
    const r = redact(sample) as Redacted;
    assert.equal(r.amount, 1250);
    assert.equal(r.tipAmount, 200);
    assert.equal(r.result, "SUCCESS");
    assert.equal(r.createdTime, 1760000000000);
    assert.equal(r.voided, false);
    assert.equal(r.id, aliasId("PAY123"));
    assert.equal(r.order.id, aliasId("ORD9"));
    assert.equal(r.employee, "[redacted object]");
    assert.equal(r.cardTransaction, "[redacted object]");
    assert.equal(r.note, "[redacted]");
    assert.equal(r.tender.label, "Credit Card");
    const flat = JSON.stringify(r);
    for (const leak of ["4242", "411111", "Jane", "JANE", "bob@", "PAY123", "ORD9"]) assert.ok(!flat.includes(leak), `leaked ${leak}`);
    assert.equal((redact({ merchantName: "Shop" }) as { merchantName: string }).merchantName, "[redacted]");
  }
  assert.equal(shapeOf({ a: { b: 1 }, c: [{ d: "x" }] })["a.b"], "number");
  assert.deepEqual(findTimezoneFields({ x: { timezone: "America/New_York" }, y: 1 }), [
    { path: "x.timezone", value: "America/New_York" },
  ]);

  console.log("clover ok");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

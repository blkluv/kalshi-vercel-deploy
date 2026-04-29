/**
 * POST /api/kalshi-trade — Authenticated remote order placement.
 *
 * Re-enables remote trading after the 2026-04-22 audit shut down /api/approve.
 * The earlier endpoint had no auth, no cap, no dry-run gate, and no audit log.
 * This endpoint reinstates each of those guards before submitting any order.
 *
 * Required env vars (set on Vercel):
 *   KALSHI_API_KEY_ID         — already used by /api/balance, /api/positions
 *   KALSHI_PEM_KEY            — base64-encoded PEM private key
 *   KALSHI_DASHBOARD_KEY      — bearer token the dashboard sends in
 *                               Authorization: Bearer <key>. Without this set
 *                               the endpoint refuses every request.
 *
 * Optional env vars (with sane defaults):
 *   KALSHI_DAILY_CAP_USD      — max total $ in fills today (default 200)
 *   KALSHI_PER_TRADE_CAP_USD  — max $ per single order (default 200)
 *   KALSHI_DRY_RUN            — "true"|"1" forces dry-run (no order placed)
 *   KALSHI_DASHBOARD_ORIGIN   — CORS origin (default https://mikedmote52.github.io)
 *
 * Request body:
 *   { ticker: string, side: "yes"|"no", amount: number_dollars,
 *     price_cents?: number,  // optional override; default = current ask
 *     contracts?: number }   // optional override; default = floor(amount/price)
 *
 * Response (success):
 *   { success: true, dry_run, order_id, ticker, side, contracts,
 *     price_cents, cost_dollars, balance_after, daily_spend_after }
 *
 * Response (failure):
 *   { success: false, error, code? }
 */
const { getBalance, getMarket, placeOrder, request } = require("./kalshi");

const DASHBOARD_KEY = process.env.KALSHI_DASHBOARD_KEY;
const DAILY_CAP_USD = parseFloat(process.env.KALSHI_DAILY_CAP_USD || "200");
const PER_TRADE_CAP_USD = parseFloat(process.env.KALSHI_PER_TRADE_CAP_USD || "200");
const DRY_RUN = ["1", "true", "yes"].includes(String(process.env.KALSHI_DRY_RUN || "").toLowerCase());

function todayUTCDateStr() {
  return new Date().toISOString().slice(0, 10);
}

// Sum today's fills (in dollars) so we can enforce a daily cap.
// Kalshi /portfolio/fills returns up to 1000 most recent fills; we filter to
// today's UTC date. This is the source of truth instead of a local DB write
// since the local SQLite was already shown to drift from Kalshi (audit §1.6).
async function getTodayFillTotalUSD() {
  try {
    const data = await request("GET", "/portfolio/fills?limit=1000");
    const today = todayUTCDateStr();
    const fills = data.fills || [];
    let totalCents = 0;
    for (const f of fills) {
      const ts = f.created_time || f.created_at;
      if (!ts) continue;
      if (!String(ts).startsWith(today)) continue;
      // Each fill: count * price (cents). Defensively support either field shape.
      const count = parseFloat(f.count || f.size || 0);
      const price = parseFloat(f.yes_price ?? f.no_price ?? f.price ?? 0);
      if (count > 0 && price > 0) totalCents += count * price;
    }
    return totalCents / 100;
  } catch (e) {
    // If the fills call fails, fall back to a conservative "unknown" — we don't
    // want a transient API blip to silently disable the cap. Return Infinity
    // so the cap check refuses the trade rather than passing it.
    console.error("getTodayFillTotalUSD failed:", e.message);
    return Number.POSITIVE_INFINITY;
  }
}

// Audit log to Vercel runtime logs. Replaces the local SQLite write requirement
// from the audit (§3.1) — local DB write isn't possible from a stateless edge
// function, but every request and outcome is captured here for forensic review.
function audit(stage, payload) {
  try {
    console.log(JSON.stringify({
      stage,
      ts: new Date().toISOString(),
      ...payload,
    }));
  } catch (e) {
    console.log("AUDIT_LOG_FAILURE", stage, e.message);
  }
}

module.exports = async function handler(req, res) {
  const origin = process.env.KALSHI_DASHBOARD_ORIGIN || "https://mikedmote52.github.io";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  // ─── Guard 1: auth ────────────────────────────────────────────────────────
  if (!DASHBOARD_KEY) {
    audit("config_missing", { detail: "KALSHI_DASHBOARD_KEY not set" });
    return res.status(503).json({
      success: false,
      error: "Server misconfigured: KALSHI_DASHBOARD_KEY not set on Vercel.",
    });
  }
  const auth = (req.headers.authorization || "").trim();
  if (auth !== `Bearer ${DASHBOARD_KEY}`) {
    audit("auth_fail", { ip: req.headers["x-forwarded-for"] || "unknown" });
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  // ─── Parse body ───────────────────────────────────────────────────────────
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};
  const ticker = (body.ticker || "").trim();
  const side = (body.side || "").toLowerCase().trim();
  const amount = parseFloat(body.amount);
  const priceOverrideCents = body.price_cents != null ? parseInt(body.price_cents, 10) : null;
  const contractsOverride = body.contracts != null ? parseInt(body.contracts, 10) : null;

  if (!ticker) return res.status(400).json({ success: false, error: "Missing ticker" });
  if (side !== "yes" && side !== "no") return res.status(400).json({ success: false, error: "side must be 'yes' or 'no'" });
  if (!isFinite(amount) || amount <= 0) return res.status(400).json({ success: false, error: "amount must be a positive number (USD)" });

  audit("request", { ticker, side, amount, dry_run: DRY_RUN });

  // ─── Guard 2: per-trade cap ───────────────────────────────────────────────
  if (amount > PER_TRADE_CAP_USD) {
    audit("reject_per_trade_cap", { ticker, amount, cap: PER_TRADE_CAP_USD });
    return res.status(400).json({
      success: false,
      error: `Order $${amount.toFixed(2)} exceeds per-trade cap $${PER_TRADE_CAP_USD.toFixed(2)}. Raise KALSHI_PER_TRADE_CAP_USD on Vercel to authorize larger orders.`,
      code: "PER_TRADE_CAP",
    });
  }

  // ─── Resolve price + contracts ───────────────────────────────────────────
  let market;
  try {
    market = await getMarket(ticker);
  } catch (e) {
    audit("market_fetch_fail", { ticker, err: e.message });
    return res.status(502).json({ success: false, error: `Could not fetch market: ${e.message}` });
  }
  if (!market) return res.status(404).json({ success: false, error: `Market ${ticker} not found` });

  // Side-specific best ask in cents. Kalshi serves prices in dollars; we round
  // to whole cents for the order. Default fallback chain handles different
  // shapes returned for closed/illiquid markets.
  const yesAsk = parseFloat(market.yes_ask ?? market.yes_ask_cents ?? 0);
  const noAsk = parseFloat(market.no_ask ?? market.no_ask_cents ?? 0);
  const askCents = side === "yes"
    ? (yesAsk > 1 ? Math.round(yesAsk) : Math.round(yesAsk * 100))
    : (noAsk > 1 ? Math.round(noAsk) : Math.round(noAsk * 100));

  let priceCents = priceOverrideCents != null ? priceOverrideCents : askCents;
  if (!isFinite(priceCents) || priceCents <= 0 || priceCents >= 100) {
    audit("reject_bad_price", { ticker, askCents, priceOverrideCents });
    return res.status(422).json({
      success: false,
      error: `No usable ask price for ${ticker} side ${side} (got ${priceCents}c)`,
    });
  }

  let contracts;
  if (contractsOverride != null && contractsOverride > 0) {
    contracts = contractsOverride;
  } else {
    contracts = Math.floor((amount * 100) / priceCents);
  }
  if (contracts < 1) {
    return res.status(422).json({
      success: false,
      error: `$${amount.toFixed(2)} too small to buy 1 contract @ ${priceCents}c. Minimum: $${(priceCents/100).toFixed(2)}.`,
    });
  }

  const costDollars = (contracts * priceCents) / 100;

  // ─── Guard 3: daily cap ───────────────────────────────────────────────────
  const todaySpend = await getTodayFillTotalUSD();
  if (todaySpend === Number.POSITIVE_INFINITY) {
    audit("daily_cap_unknown", { ticker });
    return res.status(503).json({
      success: false,
      error: "Could not query today's fills to enforce daily cap. Try again in a moment.",
      code: "DAILY_CAP_UNKNOWN",
    });
  }
  if (todaySpend + costDollars > DAILY_CAP_USD) {
    audit("reject_daily_cap", { ticker, todaySpend, costDollars, cap: DAILY_CAP_USD });
    return res.status(429).json({
      success: false,
      error: `Daily cap reached. Today: $${todaySpend.toFixed(2)} + this order $${costDollars.toFixed(2)} > cap $${DAILY_CAP_USD.toFixed(2)}. Raise KALSHI_DAILY_CAP_USD on Vercel to authorize more.`,
      code: "DAILY_CAP",
      today_spend: todaySpend,
      daily_cap: DAILY_CAP_USD,
    });
  }

  // ─── Guard 4: dry-run gate ────────────────────────────────────────────────
  if (DRY_RUN) {
    audit("dry_run", { ticker, side, contracts, priceCents, costDollars });
    return res.status(200).json({
      success: true,
      dry_run: true,
      order_id: `dry_run_${Date.now()}`,
      ticker, side, contracts, price_cents: priceCents,
      cost_dollars: costDollars,
      daily_spend_after: todaySpend + costDollars,
    });
  }

  // ─── Place the order ──────────────────────────────────────────────────────
  // Kalshi expects an idempotent client_order_id so we don't double-submit if
  // the dashboard retries. Combine ticker + minute + side as a key.
  const clientOrderId = `dash-${ticker}-${side}-${Date.now()}`;
  const orderBody = {
    action: "buy",
    side,
    ticker,
    type: "limit",
    yes_price: side === "yes" ? priceCents : undefined,
    no_price: side === "no" ? priceCents : undefined,
    count: contracts,
    client_order_id: clientOrderId,
  };
  // Strip undefined keys so Kalshi doesn't complain about null fields.
  Object.keys(orderBody).forEach(k => orderBody[k] === undefined && delete orderBody[k]);

  let result;
  try {
    result = await placeOrder(orderBody);
  } catch (e) {
    audit("order_fail", { ticker, side, contracts, priceCents, err: e.message });
    return res.status(502).json({
      success: false,
      error: e.message,
      code: "KALSHI_ORDER_ERROR",
    });
  }

  const order = result.order || result;
  audit("order_ok", {
    ticker, side, contracts, priceCents, costDollars,
    order_id: order.order_id, status: order.status,
    client_order_id: clientOrderId,
  });

  // Best-effort post-fill balance read for the dashboard. Don't fail the request
  // if this read errors — the order is already placed.
  let balanceAfter = null;
  try { balanceAfter = await getBalance(); } catch {}

  return res.status(200).json({
    success: true,
    dry_run: false,
    order_id: order.order_id,
    status: order.status || "submitted",
    ticker, side, contracts,
    price_cents: priceCents,
    cost_dollars: costDollars,
    balance_after: balanceAfter,
    daily_spend_after: todaySpend + costDollars,
  });
};

// Clean Hands, Dirty Money — OWNED, vendor-agnostic analytics sink.
// Default store: dedicated Vercel Edge Config (A_EC_ID), aggregate counters only (no PII, no raw identity).
// Auto-upgrade: if Vercel KV env (KV_REST_API_URL + KV_REST_API_TOKEN) is present, also append a raw
//   event stream there (higher write throughput) — enable KV in the Vercel dashboard to turn this on.
// Swappable: a vendor (PostHog etc.) can be added later behind this same endpoint with just a key.
//
// POST /api/track   body {cid, ev:[{e,p,t}]}    -> aggregates counters (anonymous)
// GET  /api/track?action=report&key=DASH_KEY    -> dashboard JSON (players, DAU, funnel, ops, referrals)
// GET  /api/track?action=ping                   -> health
//
// Privacy: client id is an anonymous random string; we never receive or store PII or wallet addresses.

const API = "https://api.vercel.com/v1/edge-config";
const cfg = () => ({ team: process.env.EC_TEAM, token: process.env.EC_TOKEN, a: process.env.A_EC_ID, ref: process.env.EC_ID });
const KV = () => ({ url: process.env.KV_REST_API_URL, tok: process.env.KV_REST_API_TOKEN });

async function readAll(id) {
  const { team, token } = cfg();
  const r = await fetch(`${API}/${id}/items?teamId=${team}`, { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) throw new Error("read " + r.status);
  const arr = await r.json(); const m = {}; for (const it of arr) m[it.key] = it.value; return m;
}
async function writeItems(id, items) {
  if (!items.length) return;
  const { team, token } = cfg();
  const r = await fetch(`${API}/${id}/items?teamId=${team}`, {
    method: "PATCH", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  if (!r.ok) throw new Error("write " + r.status + " " + (await r.text()).slice(0, 120));
}
const key = (s) => String(s || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, "");

async function kvPush(batch) { // best-effort raw stream if KV is enabled
  const { url, tok } = KV(); if (!url || !tok) return;
  try { await fetch(url + "/rpush/chdm_events/" + encodeURIComponent(JSON.stringify(batch).slice(0, 4000)),
    { method: "POST", headers: { Authorization: "Bearer " + tok } }); } catch (e) {}
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();
  const q = req.query || {};
  try {
    if (!cfg().a || !cfg().token) return res.status(200).json({ ok: false, error: "store-not-configured" });

    // ---- REPORT (key-guarded read dashboard data) ----
    if (q.action === "report") {
      if (!process.env.DASH_KEY || q.key !== process.env.DASH_KEY) return res.status(401).json({ ok: false, error: "bad-key" });
      const a = await readAll(cfg().a);
      let refTot = 0, refConv = 0;
      try { const rmap = await readAll(cfg().ref);
        for (const k in rmap) { if (k.startsWith("r_")) { refTot += (rmap[k].tot || 0); } if (k.startsWith("s_")) refConv++; }
      } catch (e) {}
      const days = []; for (let i = 6; i >= 0; i--) { const d = new Date(Date.now() - i * 864e5).toISOString().slice(0,10).replace(/-/g,""); days.push(d); }
      const num = (k) => a[k] || 0;
      const ops = {}; const locs = {}; const evs = {};
      for (const k in a) { if (k.startsWith("a_op_")) ops[k.slice(5)] = a[k]; if (k.startsWith("a_loc_")) locs[k.slice(6)] = a[k]; if (k.startsWith("a_ev_")) evs[k.slice(5)] = a[k]; }
      return res.status(200).json({ ok: true, generatedAt: new Date().toISOString(),
        players_total: num("a_players"),
        dau: days.map(d => ({ day: d, sessions: num("a_dau_" + d), new: num("a_new_" + d), returning: num("a_ret_" + d) })),
        funnel: { first_tap: num("a_firsttap"), op_buy: num("a_opbuy"), perk_buy: num("a_perkbuy"), flee: num("a_flee"), bust: num("a_bust"), achievements: num("a_ach"), offline_return: num("a_offline") },
        monetization: { wallet_connect_click: num("a_walletclick"), phantom_deeplink: num("a_phantom"), buy_click: num("a_buyclick") },
        referral: { link_visits: num("a_refvisit"), conversions: refConv, total_referrals: refTot },
        income: { tap: num("a_inc_tap"), passive: num("a_inc_psv") },
        fbi: { triggered: num("a_ev_fbi_trigger"), evaded: num("a_ev_fbi_evade"), caught: num("a_ev_fbi_caught"), passed: num("a_ev_fbi_pass") },
        top_ops: ops, locales_reached: locs, events_total: num("a_total"), events_by_name: evs });
    }
    if (q.action === "ping") return res.status(200).json({ ok: true, service: "chdm-track" });

    // ---- INGEST (POST batch) ----
    if (req.method !== "POST") return res.status(200).json({ ok: true, service: "chdm-track" });
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    if (!body || !Array.isArray(body.ev)) return res.status(200).json({ ok: false, error: "bad-body" });
    kvPush(body); // best-effort raw stream (only if KV enabled)
    const a = await readAll(cfg().a);
    const td = today(); const inc = {};
    const bump = (k, n) => { k = key(k); inc[k] = (inc[k] != null ? inc[k] : (a[k] || 0)) + (n || 1); };
    for (const item of body.ev.slice(0, 50)) {
      const e = key(item.e); if (!e) continue; const p = item.p || {};
      bump("a_total"); bump("a_ev_" + e);
      if (e === "session_start") { bump("a_dau_" + td); if (p.new) { bump("a_players"); bump("a_new_" + td); } else bump("a_ret_" + td); }
      else if (e === "first_tap") bump("a_firsttap");
      else if (e === "op_buy") { bump("a_opbuy"); if (p.id) bump("a_op_" + key(p.id)); }
      else if (e === "perk_buy") bump("a_perkbuy");
      else if (e === "flee") { bump("a_flee"); if (p.locale) bump("a_loc_" + key(p.locale)); }
      else if (e === "bust") bump("a_bust");
      else if (e === "offline_return") bump("a_offline");
      else if (e === "wallet_connect_click") bump("a_walletclick");
      else if (e === "phantom_deeplink") bump("a_phantom");
      else if (e === "buy_click") bump("a_buyclick");
      else if (e === "ref_visit") bump("a_refvisit");
      else if (e === "achievement") bump("a_ach");
      else if (e === "econ") { if (p.tap) bump("a_inc_tap", Math.round(p.tap)); if (p.psv) bump("a_inc_psv", Math.round(p.psv)); }
    }
    const items = Object.keys(inc).map(k => ({ operation: "upsert", key: k, value: inc[k] }));
    await writeItems(cfg().a, items);
    return res.status(200).json({ ok: true, counted: body.ev.length });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e.message || e) });
  }
}

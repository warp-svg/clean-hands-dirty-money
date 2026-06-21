// Clean Hands, Dirty Money — OWNED, vendor-agnostic analytics sink.
// Default store: dedicated Vercel Edge Config (A_EC_ID), aggregate counters only.
// Warehouse tier: Vercel KV (Upstash Redis) — activated by setting KV_REST_API_URL
//   + KV_REST_API_TOKEN env vars. Uses PFADD (HyperLogLog) for accurate unique-player
//   and DAU counting, HINCRBY for event funnel counts. Falls back to Edge Config if KV
//   is not configured. No new npm deps — all via Upstash REST API.
//
// POST /api/track   body {cid, ev:[{e,p,t}]}    -> aggregates counters (anonymous)
// GET  /api/track?action=report&key=DASH_KEY    -> dashboard JSON
// GET  /api/track?action=ping                   -> health
//
// Privacy: client id is an anonymous random string; we never receive or store PII.

const EC_API = "https://api.vercel.com/v1/edge-config";
const cfg = () => ({ team: process.env.EC_TEAM, token: process.env.EC_TOKEN, a: process.env.A_EC_ID, ref: process.env.EC_ID });
const KV  = () => ({ url: process.env.KV_REST_API_URL, tok: process.env.KV_REST_API_TOKEN });

// ---- Edge Config helpers ----
async function readAll(id) {
  const { team, token } = cfg();
  const r = await fetch(`${EC_API}/${id}/items?teamId=${team}`, { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) throw new Error("EC read " + r.status);
  const arr = await r.json(); const m = {}; for (const it of arr) m[it.key] = it.value; return m;
}
async function writeItems(id, items) {
  if (!items.length) return;
  const { team, token } = cfg();
  const r = await fetch(`${EC_API}/${id}/items?teamId=${team}`, {
    method: "PATCH", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  if (!r.ok) {
    const txt = (await r.text().catch(() => "")).slice(0, 200);
    console.error(`[track] EC write failed ${r.status}: ${txt}`);
    throw new Error("EC write " + r.status + " " + txt);
  }
}

const sanitize = (s) => String(s || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
const todayUTC = () => new Date().toISOString().slice(0, 10).replace(/-/g, "");

// ---- KV (Upstash Redis) helpers ----

// Send a batch of Redis commands in one HTTP round-trip via Upstash pipeline.
async function kvPipeline(cmds) {
  const { url, tok } = KV();
  if (!url || !tok || !cmds.length) return [];
  try {
    const r = await fetch(url + "/pipeline", {
      method: "POST",
      headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
      body: JSON.stringify(cmds),
    });
    if (!r.ok) {
      console.error("[track] KV pipeline failed:", r.status, await r.text().catch(() => ""));
      return [];
    }
    return await r.json();
  } catch (e) {
    console.error("[track] KV pipeline error:", e.message);
    return [];
  }
}

// Write inbound event batch into KV warehouse.
// Uses HyperLogLog (PFADD) for unique-player / DAU counting — idempotent,
// accurate to ~1%, no item-limit problem, constant memory.
async function kvTrack(body, td) {
  const cid = body.cid && body.cid !== "anon" ? String(body.cid).slice(0, 64) : null;
  const evs = Array.isArray(body.ev) ? body.ev : [];
  const cmds = [];

  // Raw event stream for future replay / backfill
  cmds.push(["RPUSH", "chdm:events", JSON.stringify({ cid, td, ev: evs.slice(0, 50) }).slice(0, 4000)]);
  // Cap list to last 50k events (~5MB at avg 100B/event)
  cmds.push(["LTRIM", "chdm:events", -50000, -1]);

  for (const item of evs.slice(0, 50)) {
    const e = sanitize(item.e); if (!e) continue;
    const p = item.p || {};

    // Per-event count (for funnel)
    cmds.push(["HINCRBY", "chdm:funnel", e, 1]);

    if (e === "session_start") {
      if (cid) {
        // Unique player count (survives restarts)
        cmds.push(["PFADD", "chdm:players", cid]);
        // DAU: unique CIDs per calendar day
        cmds.push(["PFADD", `chdm:dau:${td}`, cid]);
        cmds.push(["EXPIRE", `chdm:dau:${td}`, 1209600]); // 14-day TTL
        // New vs returning
        if (p.new) {
          cmds.push(["PFADD", `chdm:new:${td}`, cid]);
          cmds.push(["EXPIRE", `chdm:new:${td}`, 1209600]);
        }
      }
    } else if (e === "op_buy" && p.id) {
      cmds.push(["HINCRBY", "chdm:top_ops", sanitize(p.id), 1]);
    } else if (e === "flee" && p.locale) {
      cmds.push(["HINCRBY", "chdm:locales", sanitize(p.locale), 1]);
    }
  }

  await kvPipeline(cmds);
}

// Read KV warehouse to build report data.
async function kvReport(days) {
  const { url, tok } = KV();
  if (!url || !tok) return null;

  // Build one pipeline: [players] [funnel] [top_ops] [locales] [dau+new per day x7]
  const cmds = [
    ["PFCOUNT", "chdm:players"],
    ["HGETALL", "chdm:funnel"],
    ["HGETALL", "chdm:top_ops"],
    ["HGETALL", "chdm:locales"],
    ...days.flatMap(d => [
      ["PFCOUNT", `chdm:dau:${d}`],
      ["PFCOUNT", `chdm:new:${d}`],
    ]),
  ];

  const results = await kvPipeline(cmds);
  if (!results.length) return null;

  // HGETALL returns flat ["field","value","field","value",...]
  const h2obj = (arr) => {
    const o = {};
    if (!Array.isArray(arr)) return o;
    for (let i = 0; i < arr.length - 1; i += 2) o[arr[i]] = parseInt(arr[i + 1]) || 0;
    return o;
  };

  try {
    const players_total  = results[0]?.result || 0;
    const funnel         = h2obj(results[1]?.result);
    const top_ops_kv     = h2obj(results[2]?.result);
    const locales_kv     = h2obj(results[3]?.result);

    const dau = days.map((d, i) => {
      const sessions = results[4 + i * 2]?.result || 0;
      const newP     = results[4 + i * 2 + 1]?.result || 0;
      return { day: d, sessions, new: newP, returning: Math.max(0, sessions - newP) };
    });

    return {
      players_total,
      dau,
      funnel_kv: {
        first_tap:      funnel.first_tap      || 0,
        op_buy:         funnel.op_buy         || 0,
        perk_buy:       funnel.perk_buy       || 0,
        flee:           funnel.flee           || 0,
        bust:           funnel.bust           || 0,
        achievements:   funnel.achievement    || 0,
        offline_return: funnel.offline_return || 0,
      },
      top_ops_kv,
      locales_kv,
    };
  } catch (e) {
    console.error("[track] kvReport parse error:", e.message);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();
  const q = req.query || {};

  try {
    if (!cfg().a || !cfg().token) return res.status(200).json({ ok: false, error: "store-not-configured" });

    // ---- REPORT (key-guarded) ----
    if (q.action === "report") {
      if (!process.env.DASH_KEY || q.key !== process.env.DASH_KEY)
        return res.status(401).json({ ok: false, error: "bad-key" });

      // Read EC (always — needed for monetization, referrals, income, fbi)
      const a = await readAll(cfg().a);
      let refTot = 0, refConv = 0;
      try {
        const rmap = await readAll(cfg().ref);
        for (const k in rmap) {
          if (k.startsWith("r_")) refTot += (rmap[k].tot || 0);
          if (k.startsWith("s_")) refConv++;
        }
      } catch (e) { console.error("[track] ref EC read error:", e.message); }

      const days = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10).replace(/-/g, "");
        days.push(d);
      }

      const num = (k) => a[k] || 0;
      const ops = {}; const locs = {}; const evs = {};
      for (const k in a) {
        if (k.startsWith("a_op_"))  ops[k.slice(5)]  = a[k];
        if (k.startsWith("a_loc_")) locs[k.slice(6)] = a[k];
        if (k.startsWith("a_ev_"))  evs[k.slice(5)]  = a[k];
      }

      // Try KV warehouse (preferred — accurate unique counts, durable)
      const kv = await kvReport(days).catch(e => {
        console.error("[track] kvReport error:", e.message);
        return null;
      });
      const useKV = kv !== null;

      return res.status(200).json({
        ok: true,
        generatedAt: new Date().toISOString(),
        data_source: useKV ? "kv" : "edge-config",
        // KV preferred for player/DAU/funnel; EC still used for monet + refs
        players_total: useKV ? kv.players_total : num("a_players"),
        dau: useKV
          ? kv.dau
          : days.map(d => ({ day: d, sessions: num("a_dau_" + d), new: num("a_new_" + d), returning: num("a_ret_" + d) })),
        funnel: useKV
          ? kv.funnel_kv
          : { first_tap: num("a_firsttap"), op_buy: num("a_opbuy"), perk_buy: num("a_perkbuy"),
              flee: num("a_flee"), bust: num("a_bust"), achievements: num("a_ach"), offline_return: num("a_offline") },
        monetization: { wallet_connect_click: num("a_walletclick"), phantom_deeplink: num("a_phantom"), buy_click: num("a_buyclick") },
        referral:     { link_visits: num("a_refvisit"), conversions: refConv, total_referrals: refTot },
        income:       { tap: num("a_inc_tap"), passive: num("a_inc_psv") },
        fbi:          { triggered: num("a_ev_fbi_trigger"), evaded: num("a_ev_fbi_evade"), caught: num("a_ev_fbi_caught"), passed: num("a_ev_fbi_pass") },
        top_ops:         useKV ? kv.top_ops_kv : ops,
        locales_reached: useKV ? kv.locales_kv  : locs,
        events_total:    num("a_total"),
        events_by_name:  evs,
      });
    }

    if (q.action === "ping") return res.status(200).json({ ok: true, service: "chdm-track", kv_active: !!KV().url });

    // ---- INGEST (POST batch) ----
    if (req.method !== "POST") return res.status(200).json({ ok: true, service: "chdm-track" });
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    if (!body || !Array.isArray(body.ev)) return res.status(200).json({ ok: false, error: "bad-body" });

    const td = todayUTC();

    // KV warehouse write — best-effort, non-blocking, does not block EC write
    kvTrack(body, td).catch(e => console.error("[track] kvTrack error:", e.message));

    // EC aggregate counters (legacy + backup)
    const a = await readAll(cfg().a);
    const inc = {};
    const bump = (k, n) => { k = sanitize(k); inc[k] = (inc[k] != null ? inc[k] : (a[k] || 0)) + (n || 1); };

    for (const item of body.ev.slice(0, 50)) {
      const e = sanitize(item.e); if (!e) continue; const p = item.p || {};
      bump("a_total"); bump("a_ev_" + e);
      if (e === "session_start") {
        bump("a_dau_" + td);
        if (p.new) { bump("a_players"); bump("a_new_" + td); } else bump("a_ret_" + td);
      }
      else if (e === "first_tap")             bump("a_firsttap");
      else if (e === "op_buy")                { bump("a_opbuy"); if (p.id) bump("a_op_" + sanitize(p.id)); }
      else if (e === "perk_buy")              bump("a_perkbuy");
      else if (e === "flee")                  { bump("a_flee"); if (p.locale) bump("a_loc_" + sanitize(p.locale)); }
      else if (e === "bust")                  bump("a_bust");
      else if (e === "offline_return")        bump("a_offline");
      else if (e === "wallet_connect_click")  bump("a_walletclick");
      else if (e === "phantom_deeplink")      bump("a_phantom");
      else if (e === "buy_click")             bump("a_buyclick");
      else if (e === "ref_visit")             bump("a_refvisit");
      else if (e === "achievement")           bump("a_ach");
      else if (e === "econ") {
        if (p.tap) bump("a_inc_tap", Math.round(p.tap));
        if (p.psv) bump("a_inc_psv", Math.round(p.psv));
      }
    }

    const items = Object.keys(inc).map(k => ({ operation: "upsert", key: k, value: inc[k] }));
    await writeItems(cfg().a, items);
    return res.status(200).json({ ok: true, counted: body.ev.length });

  } catch (e) {
    console.error("[track] handler error:", e.message, e.stack?.slice(0, 300));
    return res.status(200).json({ ok: false, error: String(e.message || e) });
  }
}

// Clean Hands, Dirty Money — referral backend
// Persistent store: Vercel Edge Config (read+write via Vercel API).
// Env: EC_ID, EC_TEAM, EC_TOKEN (encrypted). No keys ever sent to the client.
//
// Actions (querystring ?action=):
//   refer  &ref=<referrerCode>&nid=<newcomerId>  -> records a referral (deduped by nid),
//                                                   queues a +1 pending bonus for the referrer.
//   claim  &code=<myCode>                        -> returns & clears this player's pending bonuses.
//   stats  &code=<myCode>                        -> returns {total, pending} without clearing.
//
// One bonus granted per unique newcomer (server-side dedupe via s:<nid> key).

const API = "https://api.vercel.com/v1/edge-config";

function cfg() {
  return { id: process.env.EC_ID, team: process.env.EC_TEAM, token: process.env.EC_TOKEN };
}
function ok(code) { return typeof code === "string" && /^[A-Za-z0-9_-]{4,24}$/.test(code); }

async function readAll() {
  const { id, team, token } = cfg();
  const r = await fetch(`${API}/${id}/items?teamId=${team}`, { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) throw new Error("read " + r.status);
  const arr = await r.json();
  const map = {};
  for (const it of arr) map[it.key] = it.value;
  return map;
}
async function write(items) {
  const { id, team, token } = cfg();
  const r = await fetch(`${API}/${id}/items?teamId=${team}`, {
    method: "PATCH",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  if (!r.ok) throw new Error("write " + r.status + " " + (await r.text()).slice(0, 120));
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  const q = req.query || {};
  const action = q.action;
  try {
    if (!process.env.EC_ID || !process.env.EC_TOKEN) {
      return res.status(200).json({ ok: false, error: "store-not-configured" });
    }
    if (action === "refer") {
      const ref = String(q.ref || ""), nid = String(q.nid || "");
      if (!ok(ref) || !ok(nid) || ref === nid) return res.status(200).json({ ok: false, error: "bad-params" });
      const map = await readAll();
      if (map["s_" + nid]) return res.status(200).json({ ok: true, already: true });
      const r = map["r_" + ref] || { tot: 0, pend: 0 };
      r.tot = (r.tot || 0) + 1; r.pend = (r.pend || 0) + 1;
      await write([
        { operation: "upsert", key: "s_" + nid, value: 1 },
        { operation: "upsert", key: "r_" + ref, value: r },
      ]);
      return res.status(200).json({ ok: true, granted: true, referrerTotal: r.tot });
    }
    if (action === "claim") {
      const code = String(q.code || "");
      if (!ok(code)) return res.status(200).json({ ok: false, error: "bad-code" });
      const map = await readAll();
      const r = map["r_" + code] || { tot: 0, pend: 0 };
      const pending = r.pend || 0;
      if (pending > 0) { r.pend = 0; await write([{ operation: "upsert", key: "r_" + code, value: r }]); }
      return res.status(200).json({ ok: true, pending, total: r.tot || 0 });
    }
    if (action === "stats") {
      const code = String(q.code || "");
      if (!ok(code)) return res.status(200).json({ ok: false, error: "bad-code" });
      const map = await readAll();
      const r = map["r_" + code] || { tot: 0, pend: 0 };
      return res.status(200).json({ ok: true, total: r.tot || 0, pending: r.pend || 0 });
    }
    return res.status(200).json({ ok: true, service: "chdm-ref", actions: ["refer", "claim", "stats"] });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e.message || e) });
  }
}

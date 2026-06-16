# Clean Hands, Dirty Money — Analytics

A **vendor-agnostic, owned-first** analytics seam. Designed as a reusable Networking-unit primitive: drop the `track()` adapter into any future game and it gets gameplay analytics for free, writing to a store **we control**.

## Architecture

```
game (client)                 owned sink (serverless)            store (owned)
─────────────                 ──────────────────────             ─────────────
track(event, props)  ──POST── /api/track  ──aggregate counters── Vercel Edge Config (chdm-analytics)
  · anon client id            · no PII, no identity              (auto-upgrades to Vercel KV if enabled)
  · batched + sendBeacon      · key-guarded /report
        │
        └── optional fan-out to window.va (Vercel Web Analytics) / future PostHog — no-op unless present
```

- **Owned by default.** Events aggregate into a dedicated Vercel **Edge Config** (`chdm-analytics`) — no third-party account. Counters only (privacy + small footprint).
- **Swappable.** `track()` also fans out to `window.va` if Vercel Web Analytics is loaded, and a vendor (PostHog, Amplitude…) can be added behind the same call with just a key — **no account is created without Matt's say-so.**
- **Scale path.** If `KV_REST_API_URL` + `KV_REST_API_TOKEN` are present (one-click *Enable KV* in the Vercel project — Matt's own account, no new signup), `/api/track` additionally appends a **raw event stream** to KV for higher write throughput + future Research export. Until then, aggregate counters in Edge Config are the source of truth.

## The `track()` adapter (client)

```js
track(event, props)          // queue an event
trackOnce(flag, event, props)// fire at most once per device (e.g. first_tap)
flushTrack(beacon)           // POST batch to /api/track (sendBeacon on unload)
```
- Anonymous client id `chdm_cid` in localStorage (random string). **No PII. No wallet address. Never links wallet→identity.**
- Batched (flush at 12 events / every 20s / on tab hide via `navigator.sendBeacon`).

## Event taxonomy

| Event | Props | When |
|---|---|---|
| `session_start` | `new` (bool) | once per device per UTC day (drives DAU + new/returning) |
| `return` | – | a prior active day existed (day-2+ retention) |
| `session_end` | `secs` | tab hidden / pagehide (session length) |
| `offline_return` | `secs` | offline-earnings claimed on return |
| `first_tap` | – | first ever count (once per device) |
| `op_buy` | `id` | a laundering op purchased |
| `perk_buy` | `id` | a Perk/upgrade purchased |
| `flee` | `passports`, `locale` | Flee-the-Country prestige (with locale reached) |
| `bust` | – | Heat hit 100% → raid |
| `achievement` | `id` | achievement unlocked |
| `ref_visit` | – | arrived via a `?ref=` referral link |
| `wallet_connect_click` | `mobile` | tapped Connect Phantom |
| `phantom_deeplink` | – | mobile universal-link into Phantom in-app browser |
| `buy_click` | – | tapped Buy on pump.fun |
| `econ` | `tap`, `psv` | every ~60s: tap-income vs passive-income $ in the window (Balance source-of-truth for the swipe nerf) |
| `fbi_trigger` | – | first federal milestone reached this run |
| `fbi_caught` | `m` | federal raid landed at milestone m (assets seized — heat was too high) |
| `fbi_pass` | `m` | crossed milestone m clean (heat below the gate) |
| `fbi_evade` | `m` | survived a milestone check (close call, or a Bribe-a-Fed skip) |

Referral **conversions** + **total referrals** are read server-side from the existing `/api/ref` Edge Config (the 2×-bonus backend), so attribution ties into the live referral system.

## Dashboard

Private, unindexed (`robots: noindex`), simple key guard (no heavy auth):

```
/dash.html?key=<DASH_KEY>
```
Shows: total players, DAU (7-day), new vs returning, the core funnel (first tap → op → perk → flee → bust → achievements → offline returns), top laundering ops, monetization-intent funnel (wallet click → Phantom deep-link → buy click), referral conversions, and locales reached. `DASH_KEY` is a Vercel env var — rotate any time in project settings.

## Privacy (brand-consistent: "non-custodial, nothing hidden")

- Anonymous IDs only; **no PII; no wallet-address-to-identity linking**; first-party + cookieless (localStorage id, not a tracking cookie).
- One-time in-game notice: *"We track anonymous gameplay stats — no wallet, no PII."* + footer line.
- GDPR-sane: no personal data collected, so no consent wall required; data is aggregate counts.

## Endpoints

- `POST /api/track` — body `{cid, ev:[{e,p,t}]}` → aggregates counters. Returns `{ok,counted}`.
- `GET /api/track?action=report&key=…` → dashboard JSON (401 on bad key).
- `GET /api/track?action=ping` → health.

## Balance config (CONFIG in index.html)
All tunables live in one `CONFIG` block: `tapCoeff` (0.02), `swipeFactor` (0.45), `helperTapMult`, `maxHelperSprites` (10), `fxCap`/`rainCap`/`pileMax` (perf), `fbiMilestones` (current-run $ checkpoints, reset on flee)/`fbiHeatGate`/`fbiSeizeFrac`, `econEmitMs`. The dashboard `/report` now also returns `income:{tap,passive}` and `fbi:{triggered,evaded,caught}` so Balance can set the tap nerf from real data.

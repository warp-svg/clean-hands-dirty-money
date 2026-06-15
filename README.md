# Clean Hands, Dirty Money

A single-page, client-side arcade game — launder your dirty money, dodge the FBI, manage
your heat, and flee before you get busted. Single-file HTML5/canvas, mobile-first. Live at
**https://clean-hands-dirty-money.vercel.app**.

This is a **self-contained, transferable unit**: it owns its own secrets and its own
backend stores, and reads nothing from the WARP factory.

## Layout
- `index.html` — the whole game + the anonymous `track()` analytics adapter and the
  referral (`/api/ref`) client calls.
- `.env.example` / `SECRETS.md` — environment template + ownership/transfer docs.

## Client API calls (server source NOT in this repo — see CAVEAT)
- `POST /api/track` — anonymous gameplay analytics sink (beacon + fetch fallback).
- `GET /api/ref?action=refer|claim|stats` — referral ledger (refer a friend, claim a
  pending bonus, read friend-count stats). Anonymous referral code in `localStorage` only.

## ⚠️ CAVEAT — recovery provenance (read before connecting to Vercel)

`index.html` was **recovered verbatim from the live Vercel deploy on 2026-06-15** (verified
byte-identical: the fetched file's MD5 matches the deploy's served ETag).

The serverless function(s) under `/api/` (e.g. `/api/track`, `/api/ref`) **could NOT be
recovered from the deploy** — Vercel does not serve serverless source. Their canonical
source lives in the **builder chat**.

**Export the `/api/` source from the builder chat — or reconstruct it and verify it against
the live response shape — BEFORE connecting this repo to Vercel auto-deploy.** A
reconstructed `/api/` that is even slightly off would otherwise **silently replace the live,
working functions** on the next deploy and break analytics / referrals (or worse, corrupt
the live data stores). Do not point Vercel at this repo until the `/api/` source is present
and verified.

## Analytics & referrals (privacy-first)
Anonymous counters and an anonymous referral code only — no account, no PII, no wallet.
See `SECRETS.md` for the env vars and the Control Room read-only key arrangement.

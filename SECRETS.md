# Clean Hands, Dirty Money — Secrets & Ownership

This game is a **self-contained, transferable unit**. It owns its own secrets and does
**not** read from the WARP factory's `Operations/.secrets`. The serverless functions read
everything from this project's **Vercel Environment Variables** at runtime.

> **Caveat:** the `/api/` functions were NOT recovered into this repo (serverless source
> is not served by the deploy — see `README.md`). The variables below are the NAMES the
> live functions are inferred to need from the client calls in `index.html` (`/api/track`
> and `/api/ref`). Reconcile against the canonical function source from the builder chat
> before wiring this repo to Vercel.

## What the game owns

| Var | Used by | Sensitive? | Notes |
|---|---|---|---|
| `EC_TEAM` | `api/track.js`, `api/ref.js` | no | Vercel team that owns the Edge Config store(s) |
| `A_EC_ID` | `api/track.js` | no | Analytics store (aggregate counters) |
| `REF_EC_ID` | `api/ref.js` | no | Referral ledger store (codes + pending claims) |
| `EC_TOKEN` | `api/track.js`, `api/ref.js` | **YES** | Reads/writes Edge Config. Use a long-lived Vercel API token. |
| `DASH_KEY` | `api/track.js` report | **YES** | Guards `GET /api/track?action=report`. Shared read-only with the Control Room. |

`.env.example` is the template. For local dev, copy it to `.env.local` (gitignored) and
fill in real values. In production, set them in **Vercel -> Project -> Settings ->
Environment Variables**, then redeploy (env changes only apply on the next deploy).

## EC_TOKEN — the durable token

`EC_TOKEN` must be a **long-lived Vercel API token** (Account -> Settings -> Tokens), not a
short-lived OAuth/device token, so analytics and referrals never expire mid-session. To
rotate: create a new token in the Vercel dashboard, update `EC_TOKEN`, redeploy.

## Control Room access (read-only)

The factory Control Room never sees `EC_TOKEN`. It is granted **only** the `DASH_KEY`
(report read key), held server-side in the Control Room's own env var and proxied — the key
never reaches the Control Room's client. To revoke the factory's access, rotate `DASH_KEY`
here and stop sharing it.

## The two endpoints

- **`/api/track`** — anonymous analytics sink. Client batches events and POSTs them
  (`navigator.sendBeacon`, fetch fallback) into the analytics Edge Config; key-guarded
  `?action=report`.
- **`/api/ref`** — referral ledger. Client calls `?action=refer&ref=<code>&nid=<self>`,
  `?action=claim&code=<self>`, and `?action=stats&code=<self>`. Anonymous referral code in
  `localStorage` (`chdm_reffed` flag, `state.refCode`) only — no PII, no account, no wallet.

## Transfer / sale checklist

1. Recover the canonical `/api/track.js` and `/api/ref.js` source from the builder chat
   (or reconstruct + verify against the live response shape) and commit them.
2. Move (or fork) this repo to the buyer's GitHub.
3. Create a new Vercel project from it.
4. Set the vars above in the new project (new `EC_TOKEN`, new `DASH_KEY`, buyer's own
   Edge Config IDs / team).
5. Deploy. Nothing else references the WARP factory — the unit stands alone.
6. Rotate any old `EC_TOKEN` / `DASH_KEY` so the previous owner loses access.

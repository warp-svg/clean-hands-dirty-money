# Clean Hands, Dirty Money — Secrets & Ownership

This game is a **self-contained, transferable unit**. It owns its own secrets and does
**not** read from the WARP factory's `Operations/.secrets`. Everything the serverless
functions need is read from this project's **Vercel Environment Variables** at runtime.

## What the game owns

| Var | Used by | Sensitive? | Notes |
|---|---|---|---|
| `EC_TEAM` | `api/track.js`, `api/ref.js` | no | Vercel team that owns the Edge Configs |
| `EC_ID` | `api/ref.js` | no | Referral store (2× bonus backend) |
| `A_EC_ID` | `api/track.js` | no | Analytics store (aggregate counters) |
| `EC_TOKEN` | both functions | **YES** | Reads/writes Edge Config. Use a long-lived Vercel API token. |
| `DASH_KEY` | `api/track.js` report | **YES** | Guards `GET /api/track?action=report`. Shared read-only with the Control Room. |
| `TOKEN_MINT` | client | no | `$CLEAN` mint on Solana (public) |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | `api/track.js` (optional) | **YES** | Only if KV raw-event stream is enabled |

`.env.example` is the template. For local dev, copy it to `.env.local` (gitignored) and
fill in real values. In production, set them in **Vercel → Project → Settings →
Environment Variables**, then redeploy (env changes only apply on the next deploy).

## EC_TOKEN — the durable token

`EC_TOKEN` must be a **long-lived Vercel API token** (Account → Settings → Tokens), not a
short-lived OAuth/device token. As of the current deploy, `EC_TOKEN` is set to the durable
account token, so analytics + referrals no longer expire mid-session. To rotate: create a
new token in the Vercel dashboard, update the `EC_TOKEN` env var, redeploy.

## Control Room access (read-only)

The factory Control Room never sees `EC_TOKEN`. It is granted **only** the `DASH_KEY`
(report read key), held server-side in the Control Room's own
`CLEAN_HANDS_DASH_KEY` env var and proxied through `/api/factory-report` — the key never
reaches the Control Room's client. To revoke the factory's access, rotate `DASH_KEY` here
and stop sharing the new value.

## Transfer / sale checklist

1. Move (or fork) this repo to the buyer's GitHub.
2. Create a new Vercel project from it.
3. Set the seven vars above in the new project (new `EC_TOKEN`, new `DASH_KEY`,
   buyer's own Edge Config IDs / team).
4. Deploy. Nothing else references the WARP factory — the unit stands alone.
5. Rotate any old `EC_TOKEN` / `DASH_KEY` so the previous owner loses access.

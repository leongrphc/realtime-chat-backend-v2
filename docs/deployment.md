# Production deployment

Public URL: https://chat.mozkan.com.tr

- Cloudflare Worker `plain-chat-web` serves the static Next.js export and proxies `/api/`, `/socket.io/`, and `/health/` to Render.
- Render `plain-chat-api` runs Express and Socket.IO in Frankfurt. `plain-chat-redis` is internal-only.
- Neon project `bitter-queen-18704845` stores PostgreSQL data in Frankfurt. Runtime uses a pooled URL; migrations use `DIRECT_DATABASE_URL`.
- Uploads are disabled by agreement. No S3/R2 credentials or bucket are needed. Production has no seeded demo accounts; register a new account.

## Deploy updates

Render automatically deploys the GitHub `main` branch. Build: `npm ci && npm run build:api`. Start: `node scripts/migrate-production.mjs && npm run start:api`. `render.yaml` documents equivalent infrastructure; do not apply a second Blueprint over the existing resources.

Frontend updates from an authenticated Cloudflare CLI:

```sh
npm ci
npm run build:cloudflare
npx wrangler deploy
```

The Worker and API must share the same random `EDGE_PROXY_SECRET` (at least 32 characters). Set the Worker secret using `npx wrangler secret put EDGE_PROXY_SECRET`; set the API value in Render's environment. This authenticates forwarded client addresses and prevents direct API access from bypassing the gateway. Preserve the original Origin header for CSRF and WebSocket checks.

Secrets belong in provider settings or ignored local env files. Never commit `.env.production`, `.dev.vars`, or database connection strings. The public health endpoint `/health/ready` checks PostgreSQL and Redis, and additionally checks S3 when uploads are enabled.

Render's free web service sleeps after inactivity, so the first API request can be slow. Redis on the free plan is ephemeral; messages and user sessions are persisted in PostgreSQL. Upgrade the Render service if always-on responsiveness is needed.

## Enable uploads later

Provision private S3-compatible storage and configure the `S3_*` values documented in `.env.example`. Set `UPLOADS_ENABLED=true` on the API, change `NEXT_PUBLIC_UPLOADS_ENABLED` in `scripts/build-cloudflare.mjs` to `true`, rebuild and redeploy. Verify upload, authorized download, and readiness before announcing availability.

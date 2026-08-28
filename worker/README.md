# Drawing Lab hosted Worker

The Worker entry is `src/domain/relayWorker.ts`. It serves the optional full
hosted stack:

- Workers Static Assets for the Vite `dist/` directory.
- `/api/results/*` encrypted temporary Result relay.
- `/mcp` provider-neutral Streamable HTTP MCP.
- D1 ciphertext storage with logical expiry and scheduled cleanup.
- Optional Browser Run PNG Preview for MCP model inspection.

Basic local Drawing Lab does not require this Worker or Cloudflare.

## Bindings

- `DB`: D1 initialized with `worker/d1-schema.sql`.
- `RATE_LIMITER`: anonymous create rate limiting.
- `ALLOWED_ORIGINS`: comma-separated exact CORS origins.
- `BROWSER` (optional): Browser Run binding for the derived 512 × 384 MCP PNG.

Without `BROWSER`, `create_drawing_result` and `continue_drawing_result` still
create encrypted Results; their structured output reports Preview as
unavailable. No paid resource or automatic fallback is required.

## Routes and tools

- `/api/results`: immutable encrypted Result create/read behavior.
- `/mcp`: MCP initialize, `tools/list`, `create_drawing_result`, and
  `continue_drawing_result`.

Both MCP tools reuse the existing operations and strict canonical validation.
MCP Results always use the compact encrypted relay. The Worker transiently sees
MCP plaintext operations during validation/encryption but must not log or store
them. D1 receives only ciphertext, IV, canonical/ciphertext byte counts, envelope
version, timestamps, and result ID. The encryption key remains only in the URL
fragment.

## Result lifetime and abuse boundaries

Results expire logically after 7 days; GET checks `expires_at` before reading.
The scheduled handler physically deletes expired rows. V0.1 reads the D1 primary
and does not configure read replication. There is no update, list, search,
account, session, ownership, ACL, or cloud-history route.

The Rate Limiting binding protects short bursts. D1 conditional insert/count
checks remain the authoritative fail-closed global create and active-ciphertext
boundaries. Request, canonical, envelope, and ciphertext hard caps prevent the
relay from becoming general blob storage. Rejections create no partial row.

## Public deployment template

`wrangler.example.jsonc` is the public, secret-free template. Copy it to the
gitignored `wrangler.local.jsonc`, then replace locally:

- `YOUR_D1_DATABASE_ID`
- `YOUR_RATE_LIMIT_NAMESPACE_ID`
- `YOUR_HOSTED_ORIGIN`

The template contains:

- `./dist` Static Assets with SPA fallback;
- selective `run_worker_first` for `/api/*` and `/mcp`, not the whole site;
- localhost origins plus one exact Hosted origin placeholder;
- one daily cleanup Cron;
- D1 and Rate Limiting bindings;
- an optional Browser Run binding;
- no R2, paid plan setting, read replication, account ID, credential, or secret.

Build, initialize, check, and deploy with a current Wrangler release that
supports Rate Limiting bindings. This repository was prepared with Wrangler
4.86.0, invoked without adding it to the application dependencies.

```bash
npm run build
npx --yes wrangler@4.86.0 d1 execute YOUR_DATABASE_NAME --file worker/d1-schema.sql --remote
npx --yes wrangler@4.86.0 deploy --dry-run --config wrangler.local.jsonc
npx --yes wrangler@4.86.0 deploy --config wrangler.local.jsonc
```

Deployment and remote D1 commands affect the maintainer's Cloudflare account;
run them only after reviewing the local config. OSS-PREP does not run production
deployment.

Never put Cloudflare tokens, login email, password, recovery codes, private
endpoints, `.env`, `.dev.vars`, or any `VITE_*` secret in the repository. D1 is
accessed only through the Worker binding.

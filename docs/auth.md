# Authentication

MCP access is gated by GitHub OAuth + a username allowlist. This doc walks through registering the GitHub OAuth App, configuring the Worker, and diagnosing common failures.

---

## 1. Register a GitHub OAuth App

1. Go to https://github.com/settings/developers → **OAuth Apps** → **New OAuth App**
2. Fill in:
   - **Application name:** anything you'll recognize (e.g. `bluedot-rag MCP`)
   - **Homepage URL:** your deployed Worker URL, e.g. `https://bluedot-rag.<account>.workers.dev`
   - **Authorization callback URL:** Homepage URL **+ `/auth/github/callback`** (exact path matters)
3. Click **Register application**
4. On the next screen:
   - Copy the **Client ID** (public, `Iv1.abcdef1234567890`)
   - Click **Generate a new client secret** and copy it (starts with `ghp_` or similar — you'll only see it once)

> **One app per deployment.** If you fork the repo and deploy your own Worker, register a fresh OAuth App with your Worker's URL as the callback.

---

## 2. Configure the Worker

The setup script (`npm run setup`) handles this interactively. To do it by hand:

```bash
# KV namespace for OAuth state + tokens
npx wrangler kv namespace create OAUTH_KV
# → copy the printed `id` into wrangler.toml under [[kv_namespaces]]

# Secrets
npx wrangler secret put GITHUB_CLIENT_ID       # paste Client ID
npx wrangler secret put GITHUB_CLIENT_SECRET   # paste Client Secret

# wrangler.toml [vars]
#   ALLOWED_USERS = "your-github-username"
#   BASE_URL = "https://bluedot-rag.<account>.workers.dev"

# Deploy
npx wrangler deploy
```

`ALLOWED_USERS` is comma-separated, case-insensitive, whitespace-tolerant: `"alice, Bob, CAROL"` allows those three.

---

## 3. Connect Claude.ai

1. Open Claude.ai → **Settings → Connectors** (or your workspace's equivalent)
2. Add a custom MCP server: `https://<worker>.workers.dev/mcp`
3. Claude.ai discovers the OAuth endpoints via `/.well-known/oauth-protected-resource/mcp`, performs DCR (Dynamic Client Registration) at `/register`, then bounces you to `/authorize`
4. You get redirected to GitHub → sign in → approve the OAuth App
5. GitHub redirects back to `/auth/github/callback`, the Worker checks `ALLOWED_USERS`, mints a bearer token, sends you back to Claude.ai
6. Claude.ai exchanges the code at `/token` for a 1-hour access token + 30-day refresh token and calls `/mcp` for the first time

After this, Claude.ai auto-refreshes. Until the refresh token expires (30 days of inactivity), you won't be prompted again.

---

## 4. Troubleshooting

### `redirect_uri_mismatch` from GitHub

The callback URL in the GitHub OAuth App must exactly match `<BASE_URL>/auth/github/callback`. Trailing slashes matter. Re-check the GitHub App's Authorization callback URL.

### `403 Not authorized: <login>`

Your GitHub username isn't in `ALLOWED_USERS`.

- Edit `wrangler.toml` → `ALLOWED_USERS = "..."`
- `npx wrangler deploy`
- In Claude.ai, disconnect and reconnect the MCP server to re-trigger the OAuth flow.

### `400 Invalid or expired state`

The OAuth `state` parameter either expired (>5 minutes between `/authorize` and `/auth/github/callback`) or was already consumed. Start over — begin the OAuth flow from Claude.ai again.

### `401 Missing or invalid access token` on every `/mcp` request

Claude.ai's cached token is stale or was revoked.

- Reconnect the MCP server in Claude.ai settings.
- Or hit `POST /auth/revoke` with the bad bearer to explicitly revoke it, then reconnect.

### `502 GitHub token exchange failed`

Usually one of:

- Wrong `GITHUB_CLIENT_SECRET` (most common — did you regenerate it on GitHub and forget to update the Worker secret?)
- GitHub rate limit on OAuth (very rare for single users)
- GitHub OAuth App is disabled or deleted

Tail logs while reproducing: `npx wrangler tail`. The 502 path prints the upstream status.

### Claude.ai says "couldn't connect to MCP server"

Walk the flow step by step:

```bash
# 1. Well-known metadata should be JSON with the right resource URL
curl https://<worker>/.well-known/oauth-protected-resource/mcp | jq .
# Expect: resource == "https://<worker>/mcp"

curl https://<worker>/.well-known/oauth-authorization-server | jq .
# Expect: authorization_endpoint, token_endpoint, registration_endpoint set

# 2. /mcp should 401 with WWW-Authenticate when no bearer
curl -i -X POST https://<worker>/mcp
# Expect: 401 with WWW-Authenticate: Bearer resource_metadata="..."

# 3. /authorize should 302 to github.com
curl -i "https://<worker>/authorize?response_type=code&client_id=test&redirect_uri=https://claude.ai/callback&state=x"
# Expect: 302, Location: https://github.com/login/oauth/authorize?client_id=...
```

If any of these is wrong, the issue is on the Worker side. If all three look right, the issue is usually a `redirect_uri_mismatch` caught by GitHub after you sign in.

### "Mcp-Session-Id" header errors

We run the MCP transport in stateless mode — there's no session. If a client insists on a session ID, check that Claude.ai is using `application/json` responses (via `Accept: application/json, text/event-stream`). The transport's `enableJsonResponse: true` handles both.

---

## 5. Revoking access

**A specific bearer token (yours):**

```bash
curl -X POST https://<worker>/auth/revoke \
  -H "Authorization: Bearer <token>"
# → { revoked: true }
```

Next request with that bearer returns 401.

**All of someone's grants:**

Remove them from `ALLOWED_USERS` in `wrangler.toml` and redeploy. Their existing tokens stop working — the token is still valid in the OAuth provider's store, but every `/mcp` call hits the Worker which re-checks the allowlist on each call via the stored grant's `userId`.

Actually — correction — the allowlist is checked only during the GitHub callback (once, at token mint time). Pre-existing tokens persist until Claude.ai refreshes them (every hour) or you manually revoke. If you need immediate revocation:

```bash
# Purge all OAuth state
npx wrangler kv key list --binding OAUTH_KV | jq -r '.[].name' | \
  xargs -I {} npx wrangler kv key delete "{}" --binding OAUTH_KV
```

This nukes every grant, token, and client record. Claude.ai will need to re-register and re-authorize.

---

## 6. GitHub OAuth App security notes

- The `scope` requested is `read:user user:email` — minimal. We only need the `login` (username) to check against the allowlist.
- `client_secret` is stored as a Cloudflare secret (never in the repo).
- The OAuth `state` parameter has a 5-minute TTL and is deleted on first read; a stolen state token cannot be replayed.
- Bearer tokens are 1 hour (access) / 30 days (refresh). Override via `accessTokenTTL` / `refreshTokenTTL` in `src/mcp/index.ts` if needed.
- We do not store the GitHub access token beyond the callback — only the username is persisted (in the OAuth provider's grant record).

---

## See also

- [README.md](../README.md) — setup + deploy walkthrough
- [architecture.md](./architecture.md) — full OAuth flow diagram
- [tools.md](./tools.md) — MCP tool reference

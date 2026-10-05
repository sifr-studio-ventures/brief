# Brief

Self-hosted reader and scheduler for X and LinkedIn. It runs as one Cloudflare Worker and uses your own logged-in browser session, not the official APIs.

That breaks X’s and LinkedIn’s terms. An account can be flagged. Keep the Worker private. Do not put these cookies on a shared server.

Internals change and can break. X posting, liking, and reposting need a real account to verify. LinkedIn comments, profile view, and likes need a real account to verify. Workers cron cannot run every 30 seconds; due posts send once a minute. A send that dies after the site accepts it can post twice on retry.

## Local

Node 20+.

```bash
npm install
npx wrangler d1 migrations apply brief --local
```

Put secrets in `.dev.vars` (gitignored):

```bash
openssl rand -base64 32
```

```
APP_PASSWORD=choose-a-password
SESSION_KEY=base64-of-32-bytes
```

```bash
npm run dev
```

Open http://127.0.0.1:8787. The session cookie is HttpOnly and SameSite=Lax. On HTTPS it is also Secure. Local HTTP omits Secure so the browser will keep it.

Sign in to X or LinkedIn from your machine. The Worker cannot launch Chrome.

```bash
npm run login -- x
npm run login -- linkedin
```

`BRIEF_URL` defaults to `http://127.0.0.1:8787`. For a deployed Worker set `BRIEF_URL` to its `https://` origin and `APP_PASSWORD` in the environment. The script opens installed Chrome, waits through 2FA, and posts cookies to the Worker. It stores nothing in the repo. Profiles stay in `.profiles/`.

## Deploy

Create the database, bucket, and secrets, then paste the database id into `wrangler.toml` in place of the placeholder. No secrets belong in that file.

```bash
npx wrangler d1 create brief
npx wrangler r2 bucket create brief-media
npx wrangler d1 migrations apply brief --remote
npx wrangler secret put APP_PASSWORD
npx wrangler secret put SESSION_KEY
npm run deploy
```

`SESSION_KEY` is 32 bytes, base64 (`openssl rand -base64 32`). It encrypts X and LinkedIn cookies at rest. The password is the only gate.

## Security

- One password (`APP_PASSWORD`). The session id is random, hashed in D1, and expires in 14 days.
- X and LinkedIn cookies are AES-GCM encrypted with `SESSION_KEY`. The Worker decrypts them only to call those sites.
- Cookies, the password, authorization headers, and post text are not logged and cookies are not returned to the browser.
- HTML responses send `Content-Security-Policy: default-src 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `X-Frame-Options: DENY`.
- D1 queries are parameterized. Uploads are jpeg, png, gif, or webp, up to 5MB, and are served only after sign-in.
- R2 is private. The bucket is not public.

Font: Outfit, SIL Open Font License, in `public/fonts/`.

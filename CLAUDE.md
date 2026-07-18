# Kaka — agent setup runbook

You are setting up a fresh personal Kaka for the person you're talking to.
Kaka deploys as a single Cloudflare Worker with one KV namespace. Target
time: under 10 minutes. The README covers the same steps for humans; this
file tells you exactly what to automate and what to hand to the user.

## What the user must have (ask up front, don't start without them)

1. A Cloudflare account (free) — https://dash.cloudflare.com/sign-up
2. A Gemini API key (free) — https://aistudio.google.com/apikey
   They keep the key to themselves; you never need to see it.

## Steps

1. `npm install`
2. Personalize `src/config.ts`. Ask the user, one question at a time:
   their name (DEFAULT_USERNAME), and whether the default five pillars fit
   their life or need renaming (edit PILLARS ids/labels/emojis/descriptions
   — descriptions teach the AI, so make them concrete to this person).
   Set PUSH_CONTACT to their email as `mailto:...`.
3. `npx web-push generate-vapid-keys` — put the public key in
   `src/config.ts` (VAPID_PUBLIC_KEY). Keep the private key in hand for
   step 8; it is generated locally, so you may handle it.
4. `npx wrangler login` — this opens a browser page; the user clicks Allow.
5. `npx wrangler kv namespace create KAKA_KV` — paste the printed id into
   `vite.config.ts` replacing PASTE_YOUR_KV_NAMESPACE_ID.
6. `npm run build`
7. `npx wrangler deploy` — note the workers.dev URL it prints.
8. `npx wrangler secret put VAPID_PRIVATE_KEY` — you may pipe the key from
   step 3 into this yourself.
9. Secrets you must NOT collect: have the user run these two commands in
   their own terminal and type the values at wrangler's prompt. Never ask
   for the password or API key in chat.
   - `npx wrangler secret put SITE_PASSWORD` (a password they choose;
     it gates their app and their data)
   - `npx wrangler secret put GEMINI_API_KEY`
10. Verify: fetch the workers.dev URL — expect the login page (HTTP 401
    with the Kaka form). Have the user open it, log in, and add it to
    their phone's home screen for push notifications.

## Gotchas

- Deploy from the repo root (the build writes a `.wrangler/deploy/config.json`
  redirect there). Running wrangler inside `.output/server` fails with a
  config conflict.
- Secrets only take effect on the deployed Worker; if a secret was set
  before the first deploy fails to stick, redeploy and re-check.
- Updates later: `git pull`, `npm run build`, `npx wrangler deploy`.
  Data lives in KV, so redeploys never touch it.

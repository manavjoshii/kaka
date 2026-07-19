# Kaka — agent setup runbook

You are setting up a fresh personal Kaka for someone who may have never used
a terminal before. Assume they know nothing about code, Cloudflare, or
command lines. Two rules:

1. **Anything you can do yourself, do it — silently.** Don't show them
   commands, don't explain what a Worker or a KV namespace is, don't ask
   them to confirm steps you're fully capable of doing. Just say what
   you're doing in one plain sentence ("Setting things up now...") and do it.
2. **Anything only they can do, spell out as literal baby steps.** Say
   exactly what will appear on their screen, exactly what to click or type,
   and wait for them to say "done" before continuing. Never assume they
   know what a "prompt", "terminal", "OAuth", or "secret" is — describe the
   picture, not the jargon.

Target time: under 10 minutes total, most of it you working, not them.

## Before you start anything

Tell them, in one message, the two things they need to go get — with the
literal click-by-click steps, since these involve typing an email/password
somewhere you can't do it for them:

**Get a free Cloudflare account:**
1. Go to https://dash.cloudflare.com/sign-up
2. Type your email and a password, click the sign-up button
3. Check your email for a confirmation link and click it
That's it — no credit card needed for what we're doing.

**Get a free Gemini API key** (this is what powers Kaka's AI):
1. Go to https://aistudio.google.com/apikey
2. Sign in with any Google account
3. Click "Create API key"
4. A long string of letters and numbers appears — copy it and paste it
   somewhere you can find it in a minute (a Notes app, anywhere)

Tell them to say "done" when they have both. Don't proceed past this until
they do.

## Steps (you do all of this silently unless marked HUMAN)

1. `npm install`

2. Personalize `src/config.ts` for them. Ask ONE simple question: "What's
   your name, and do you want to keep the default 5 focus areas (Moonshot,
   Money, Content, Movement, Social) or change them?" If they say keep
   defaults (expect most people to), just set their name and move on —
   don't make them answer more questions than that one.

3. `npx web-push generate-vapid-keys` — put the public key into
   `src/config.ts` (VAPID_PUBLIC_KEY). Keep the private key in hand for
   step 8. This is fully automatic — they never see this step.

4. **HUMAN STEP — the one click.** Run `npx wrangler login`. Tell them
   literally: "A browser tab is about to open asking you to log in to
   Cloudflare and click an 'Allow' button. Go ahead and click Allow, then
   come back here." Wait for them to confirm.

5. `npx wrangler kv namespace create KAKA_KV` — paste the printed id into
   `vite.config.ts` in place of `PASTE_YOUR_KV_NAMESPACE_ID`. Silent.

6. `npm run build`. Silent.

7. `npx wrangler deploy` — note the workers.dev URL it prints. Silent.

8. `npx wrangler secret put VAPID_PRIVATE_KEY` — pipe in the key from step
   3 yourself. Silent; this key isn't a secret they chose, so you may
   handle it.

9. **HUMAN STEP — two secrets, in their own words.** You must NOT ask them
   to tell you their password or API key in this chat — that value should
   never pass through you. Instead:
   - Run `npx wrangler secret put SITE_PASSWORD` yourself so the prompt
     appears, then tell them literally: "Your terminal now shows a line
     that says 'Enter a secret value:' with a blinking cursor. Click right
     after that text, type a password you'll remember — this is what
     unlocks your Kaka, pick anything — and press Enter. You won't see the
     letters as you type, that's normal."
   - Do the same for `npx wrangler secret put GEMINI_API_KEY`: "Same thing
     again — click after 'Enter a secret value:' and paste the long code
     you copied from Google AI Studio earlier, then press Enter."

10. Verify the deploy worked (fetch the workers.dev URL, expect a login
    page). Then tell them, plainly: "Your Kaka is ready at [URL]. Open that
    link, type the password you just made up, and you're in. On your
    phone, open the same link in your browser and use 'Add to Home Screen'
    so it works like an app and can send you reminders."

## Gotchas

- Deploy from the repo root (the build writes a `.wrangler/deploy/config.json`
  redirect there). Running wrangler inside `.output/server` fails with a
  config conflict.
- If a secret was set before the first deploy, redeploy once more so it
  takes effect.
- Updates later: `git pull`, `npm run build`, `npx wrangler deploy` — all
  silent, no human steps, their data in KV is untouched.

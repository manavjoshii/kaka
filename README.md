# Kaka

A todo and habit tracker with an AI brain. You type in plain language, it does the rest.

Kaka is not a service. You deploy your own copy on your own free Cloudflare account. Your data sits in your own storage, the AI runs on your own free Gemini key, and nobody else is in the loop.

Built by [Manav Joshi](https://manavjoshi.com) for himself first. This is the same app he runs every day, minus the parts wired to his personal setup.

## What it does

- **Plain-language capture.** "Call the accountant Friday 4pm, remind me an hour before" becomes a scheduled, reminded task. Brain dumps get split into items. Goal-sized captures get broken into first moves instead of rotting as one vague todo.
- **A morning ritual.** Kaka pre-picks the three tasks that matter most today. One tap accepts.
- **An evening shutdown.** Close the day, see what moved, write one line about it.
- **Daily pillars.** Define the areas your day should touch (see below). Every task and habit is silently classified, and a chip strip shows which pillars you fed today.
- **Habits with streaks.** Daily or specific weekdays, with XP and levels on top.
- **Real reminders.** Web push notifications from a cron, on by default for every dated task. Works on your phone once you add the app to your home screen.
- **A weekly review.** The AI reads your week and writes you 4 to 6 honest sentences every Monday.
- **Life logging.** Meals, workouts, sleep, learnings, questions. It files each one where it belongs.
- **Calendar in the day view.** Paste any secret ICS URL (Google Calendar has one) in settings.
- **Cross-device sync.** One password, any device, last write wins.

## Set up

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and a free [Gemini API key](https://aistudio.google.com/apikey). About 10 minutes.

Using Claude Code or another coding agent? Open this folder and say "set up my Kaka". The repo carries a runbook (`CLAUDE.md`) that walks the agent through everything, and it will only stop to ask for the two account signups, one login click, and your secrets.

```bash
git clone https://github.com/manavjoshii/kaka.git
cd kaka
npm install
```

**1. Make it yours.** Open `src/config.ts`. Set your name, your pillars, and paste in a VAPID public key for push notifications:

```bash
npx web-push generate-vapid-keys
```

**2. Log in to Cloudflare.**

```bash
npx wrangler login
```

**3. Create the storage.**

```bash
npx wrangler kv namespace create KAKA_KV
```

Paste the id it prints into `vite.config.ts` where it says `PASTE_YOUR_KV_NAMESPACE_ID`.

**4. Build and deploy.**

```bash
npm run build
npx wrangler deploy
```

**5. Set your secrets.** Run each of these; wrangler prompts for the value.

```bash
npx wrangler secret put SITE_PASSWORD      # the password that gates your app
npx wrangler secret put GEMINI_API_KEY     # from aistudio.google.com/apikey
npx wrangler secret put VAPID_PRIVATE_KEY  # the private key from step 1
```

Open the workers.dev URL wrangler printed, enter your password, add it to your phone's home screen. Done.

To update later: pull, `npm run build`, `npx wrangler deploy`.

## Daily pillars

The pillar system is the opinionated part. The defaults are Deep Work, Health, People, Learning. The rule: every day should touch all of them, and the suggested morning picks always include at least one Deep Work task. Picks are ranked by rules you can read: real deadlines first, important over busy, and nothing rots unseen.

All of it lives in `src/config.ts`. Rename the pillars, change how many there are, rewrite the descriptions so the AI knows what belongs where, or switch off the keystone rule. Ready-made presets (Builder, Student) sit in the comments. The chips, the AI classification, and the weekly review all follow the config.

## Automation bridge

Three endpoints let your own scripts talk to your Kaka, authenticated with `?key=<your site password>`:

- `GET /api/digest?key=...&date=YYYY-MM-DD` returns one day of activity as markdown plus captured learnings. Pipe it into Obsidian, Notion, a journal, anywhere.
- `POST /api/context?key=...` pushes a plain-text slice of personal context (your goals, your projects) so the AI's answers know who it's talking to.
- `GET /api/review?key=...` returns the latest weekly review as JSON.

## Stack

TanStack Start, React, Tailwind, nitro, deployed as a single Cloudflare Worker. One KV namespace for state. Gemini 2.5 Flash for parsing and reviews. Web push over VAPID, delivered by a 5-minute cron. Runs comfortably inside Cloudflare's and Google's free tiers for a single user.

## License

MIT. Use it, change it, ship your own version.

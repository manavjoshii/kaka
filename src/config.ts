/* ═══════════════════════════════════════════════════════════════════════
 * Kaka config — the one file to edit to make Kaka yours.
 *
 * Everything personal lives here: your name, your daily pillars, and the
 * web-push keys. The rest of the app derives from these values.
 * ═══════════════════════════════════════════════════════════════════════ */

/** Shown in the greeting until you tap your name in the app and change it. */
export const DEFAULT_USERNAME = "Friend";

/**
 * Your daily pillars — the areas of life every day should touch. The AI
 * silently classifies every todo and habit into one of these (or "none" for
 * chores), the day view shows a chip per pillar that lights up when you've
 * touched it, and the weekly review judges the week's balance across them.
 *
 * Rename, reorder, add, or remove pillars freely — keep each `id` short and
 * lowercase. The `description` teaches the AI what belongs in the pillar, so
 * make it concrete: name your actual projects and activities.
 */
export const PILLARS = [
  {
    id: "moonshot",
    label: "Moonshot",
    emoji: "🚀",
    description:
      "long-term ambitious building — your startup, product, craft, studies, deep work on the big thing",
  },
  {
    id: "money",
    label: "Money",
    emoji: "💰",
    description: "revenue — clients, consulting, invoices, sponsorships, sales, deals",
  },
  {
    id: "content",
    label: "Content",
    emoji: "🎬",
    description:
      "creating or publishing — reels, scripts, posts, videos, editing, writing",
  },
  {
    id: "movement",
    label: "Movement",
    emoji: "🏃",
    description: "physical — gym, walks, sport, stretching, any exercise",
  },
  {
    id: "social",
    label: "Social",
    emoji: "🤝",
    description: "people — calls, meetups, family, friends, networking",
  },
] as const;

/**
 * The pillar guaranteed a slot in the suggested morning picks — "every day
 * contains at least one X task". Set to an id from PILLARS, or null to
 * disable the rule.
 */
export const KEYSTONE_PILLAR: string | null = "moonshot";

/**
 * Web-push VAPID keys — required for reminders/notifications.
 * Generate your own pair:  npx web-push generate-vapid-keys
 * Paste the PUBLIC key here (it's public by design — it's embedded in every
 * push subscription). Set the PRIVATE key as a Worker secret:
 *   npx wrangler secret put VAPID_PRIVATE_KEY
 */
export const VAPID_PUBLIC_KEY = "PASTE_YOUR_VAPID_PUBLIC_KEY_HERE";

/**
 * Contact for the push service (spec requirement) — your email, kept in the
 * mailto: form.
 */
export const PUSH_CONTACT = "mailto:you@example.com";

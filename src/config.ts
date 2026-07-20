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
    id: "deepwork",
    label: "Deep Work",
    emoji: "🎯",
    description:
      "the big thing you're building or becoming — career-defining effort, your craft, your studies, focused work that compounds",
  },
  {
    id: "health",
    label: "Health",
    emoji: "💪",
    description: "the body — gym, walks, sport, food choices, sleep, any exercise",
  },
  {
    id: "people",
    label: "People",
    emoji: "❤️",
    description: "relationships — family, friends, calls, meetups, community, networking",
  },
  {
    id: "learning",
    label: "Learning",
    emoji: "📚",
    description: "growth — reading, courses, skills, practice, curiosity",
  },
] as const;

/* Other presets — replace PILLARS above with one of these, or write your own.
 *
 * Builder:
 *   moonshot 🚀 "long-term ambitious building — startup, product, deep work on the big thing"
 *   money    💰 "revenue — clients, invoices, sponsorships, sales, deals"
 *   content  🎬 "creating or publishing — reels, scripts, posts, editing, writing"
 *   movement 🏃 "physical — gym, walks, sport, any exercise"
 *   social   🤝 "people — calls, meetups, family, friends, networking"
 *
 * Student:
 *   study    📖 "coursework, assignments, exam prep, thesis"
 *   health   💪 "the body — gym, sport, sleep, food"
 *   people   ❤️ "family, friends, campus life"
 *   craft    🛠 "side projects, portfolio, skills beyond the syllabus"
 */

/**
 * The pillar guaranteed a slot in the suggested morning picks — "every day
 * contains at least one X task". Set to an id from PILLARS, or null to
 * disable the rule.
 */
export const KEYSTONE_PILLAR: string | null = "deepwork";

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

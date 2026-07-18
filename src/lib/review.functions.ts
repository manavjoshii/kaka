import { createServerFn } from "@tanstack/react-start";
import { generateText } from "ai";
import { z } from "zod";
import { createAiProvider } from "./ai-gateway.server";
import { getCfEnv } from "./cf-context.server";
import { PILLARS } from "../config";

const STATE_KEY = "kaka:state:v1";
const LATEST_KEY = "kaka:review-latest";

export type WeeklyReview = {
  weekOf: string; // Monday the review was generated on (yyyy-mm-dd)
  generatedAt: number;
  text: string;
};

const REVIEW_SYSTEM = `You write a short weekly review for a personal todo/habit app user.
You get their raw activity log for the past week (captures, completions, habit check-ins,
deletions, reschedules) plus their currently open tasks.

Write 4-6 sentences, second person, warm but honest — like a sharp friend, not a coach.
Cover: what actually got done (call out the wins concretely), habit consistency (which held,
which slipped), anything that keeps getting pushed or sits untouched, and END with exactly
one specific suggestion for this week. No headers, no bullet lists, no emojis, no flattery
padding. If the week was thin, say so plainly and keep it shorter.

The user's rule: every day should touch their daily pillars —
${PILLARS.map((p) => `${p.id} (${p.description})`).join("; ")}.
Where events carry a "bucket" in their meta, judge the week's balance across the pillars
and call out any pillar that got starved.

If a FITNESS_FLOOR is provided, judge whether the week kept it (habit check-ins and
"logged" events are the evidence) and say so plainly. If the floor has now been kept two
weeks running, propose ONE small next rung (e.g. 15→20 minutes, or a sleep rule) — the
user accepts by telling the app "update my floor". If VAULT_CONTEXT is provided, use it
to connect the week to what they're actually building.`;

/** Returns the cached review for this week, generating it on first request
 *  after the week starts. The client passes its local week boundaries so the
 *  Worker's UTC clock never shifts what "this week" means. */
export const getWeeklyReview = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        weekOf: z.string(), // Monday of the current week, yyyy-mm-dd (local)
        startMs: z.number(), // start of previous Monday (local) — window start
        endMs: z.number(), // start of current Monday (local) — window end
      })
      .parse(d),
  )
  .handler(async ({ data }): Promise<WeeklyReview | null> => {
    const kv = getCfEnv().KAKA_KV;
    if (!kv) return null;

    const cacheKey = `kaka:review:${data.weekOf}`;
    const cached = await kv.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as WeeklyReview;
      } catch {
        // regenerate below
      }
    }

    const key = process.env.GEMINI_API_KEY;
    if (!key) return null;

    const raw = await kv.get(STATE_KEY);
    if (!raw) return null;
    let state: {
      history?: { ts: number; kind: string; title: string; meta?: Record<string, unknown> }[];
      todos?: { title: string; done: boolean; dueAt?: number }[];
    };
    try {
      state = JSON.parse(raw);
    } catch {
      return null;
    }

    const events = (state.history ?? []).filter(
      (e) => e.ts >= data.startMs && e.ts < data.endMs && e.kind !== "captured",
    );
    // A review of three events is noise — wait until there's a real week.
    if (events.length < 5) return null;

    const eventLines = events
      .sort((a, b) => a.ts - b.ts)
      .slice(-200)
      .map((e) => {
        const meta = e.meta && Object.keys(e.meta).length > 0 ? ` ${JSON.stringify(e.meta)}` : "";
        return `${new Date(e.ts).toISOString().slice(0, 16)} ${e.kind} — ${e.title}${meta}`;
      })
      .join("\n");
    const openLines = (state.todos ?? [])
      .filter((t) => !t.done)
      .slice(0, 25)
      .map((t) => `- ${t.title}${t.dueAt ? ` (due ${new Date(t.dueAt).toISOString().slice(0, 10)})` : ""}`)
      .join("\n");

    // Floor + vault context make the review judge against the user's own
    // standard instead of generic productivity advice. Both optional.
    const grounding: string[] = [];
    try {
      const [floor, vault] = await Promise.all([
        kv.get("kaka:floor:v1"),
        kv.get("kaka:vault-context:v1"),
      ]);
      if (floor) grounding.push(`FITNESS_FLOOR:\n${floor.slice(0, 1500)}`);
      if (vault) grounding.push(`VAULT_CONTEXT:\n${vault.slice(0, 3000)}`);
    } catch {
      // optional
    }

    const gateway = createAiProvider(key);
    const { text } = await generateText({
      model: gateway("gemini-2.5-flash"),
      system: REVIEW_SYSTEM,
      prompt: `Week: ${new Date(data.startMs).toDateString()} to ${new Date(data.endMs).toDateString()}\n\nActivity log:\n${eventLines}\n\nStill open:\n${openLines}${grounding.length ? "\n\n" + grounding.join("\n\n") : ""}`,
    });

    const review: WeeklyReview = {
      weekOf: data.weekOf,
      generatedAt: Date.now(),
      text: text.trim(),
    };
    await kv.put(cacheKey, JSON.stringify(review), { expirationTtl: 90 * 24 * 3600 });
    await kv.put(LATEST_KEY, JSON.stringify(review));
    return review;
  });

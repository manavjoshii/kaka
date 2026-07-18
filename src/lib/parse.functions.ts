import { createServerFn } from "@tanstack/react-start";
import { generateText } from "ai";
import { z } from "zod";
import { createAiProvider } from "./ai-gateway.server";
import { getCfEnv } from "./cf-context.server";
import { PILLARS } from "../config";

export const FLOOR_KEY = "kaka:floor:v1";
export const VAULT_CONTEXT_KEY = "kaka:vault-context:v1";
export const LEARNINGS_KEY = "kaka:learnings:v1";

export type StoredLearning = { ts: number; learning: string; source?: string };

const Input = z.object({
  text: z.string().min(1),
  /** Prior assistant question for follow-up turn */
  pending: z
    .object({
      original: z.string(),
      question: z.string(),
    })
    .optional(),
  knownHabits: z.array(z.string()).optional(),
  openTodos: z.array(z.string()).optional(),
});

/** One item inside a batch capture (brain dump / voice note). */
export type BatchItem = {
  kind: "todo" | "habit";
  title: string;
  urgent?: boolean;
  important?: boolean;
  bucket?: string;
  dueAt?: string;
  /** Minutes before dueAt to notify; 0 = at time; -1 = muted; absent = default. */
  alarmLeadMin?: number;
  recurrence?: "yearly" | "monthly" | "weekly";
  emoji?: string;
  days?: string[];
};

export type SmartResult = (
  | {
      intent: "todo";
      title: string;
      urgent: boolean;
      important: boolean;
      dueAt?: string;
      surfaceAt?: string;
      recurrence?: "yearly" | "monthly" | "weekly";
      /** Minutes before dueAt to notify; 0 = at time; -1 = muted; absent = default. */
      alarmLeadMin?: number;
      /** One of the five daily pillars, or absent for pure chores. */
      bucket?: string;
      reasoning?: string;
    }
  | {
      intent: "habit";
      title: string;
      emoji: string;
      /** Weekday names ("mon".."sun") for non-daily habits; absent = daily. */
      days?: string[];
      bucket?: string;
      reasoning?: string;
    }
  | {
      /** The input was a goal/project, not a todo — here's how it starts. */
      intent: "breakdown";
      goal: string;
      message: string;
      subtasks: {
        title: string;
        urgent: boolean;
        important: boolean;
        bucket?: string;
        dueAt?: string;
      }[];
    }
  | {
      intent: "complete" | "delete";
      match: string;
      reasoning?: string;
    }
  | {
      intent: "clarify";
      question: string;
    }
  | {
      /** A life log — food, workout, sleep, weight, anything that happened. */
      intent: "log";
      note: string;
      domain?: "food" | "fitness" | "sleep" | "other";
    }
  | {
      /** Pasted content distilled to its insight — saved to the learnings queue. */
      intent: "learning";
      learning: string;
      source?: string;
    }
  | {
      /** A question answered directly, grounded in floor + vault + recent logs. */
      intent: "advice";
      reply: string;
    }
  | {
      /** The user moved their fitness goalpost — full rewritten floor text. */
      intent: "floor_update";
      floor: string;
      message: string;
    }
  | {
      /** A brain dump with several distinct items — proposed all at once. */
      intent: "batch";
      message?: string;
      items: BatchItem[];
    }
  | {
      intent: "unknown";
      message: string;
    }
) & {
  /** A durable fact about a person/project worth keeping — filed to the
   *  second brain and fed back into future grounding. */
  remember?: string;
};

const SYSTEM = `You are the brain of a personal productivity app that has TODOS and HABITS.

TODOS are one-off tasks. They have two boolean flags:
- urgent: time-sensitive, must be done soon (today/this week, has a deadline)
- important: high-value, contributes to long-term goals
These place the task Eisenhower-style: Do now (urgent+important), Schedule (important, not urgent), Later (everything else).

TODOS may also have a due date+time. If the user mentions or implies any time reference
("tomorrow", "Friday", "next week", "in 2 hours", "tonight", "5pm", "Mon 9am", "end of month"),
resolve it to a concrete ISO 8601 datetime in the user's local timezone using the CURRENT_DATETIME
provided below. Time-only ("5pm") => today at 5pm (or tomorrow if already past). Date-only => 9:00 AM.
If no time reference at all, omit dueAt.

TODOS may also have a surfaceAt — the moment the task should start appearing in the
priority matrix. Anything earlier sits silently in "Upcoming" so it doesn't clutter today.
- If the user explicitly says "remind me N days/weeks before" or "X days ahead", compute surfaceAt = dueAt - that interval.
- Otherwise, if dueAt is MORE THAN 7 days in the future, default surfaceAt = dueAt - 7 days.
- If dueAt is within 7 days (or there is no dueAt), OMIT surfaceAt — the task surfaces immediately.

TODOS may also recur. If the user says "every year", "annually", "every month", "every week",
or describes an annual event like a birthday/anniversary on a specific date, set recurrence
to "yearly" | "monthly" | "weekly". Examples that imply yearly: "Wish mom happy birthday on Sept 9",
"Pay annual insurance on March 1", "Anniversary dinner April 12".
IMPORTANT: birthdays, anniversaries, annual bills are TODOS with recurrence:"yearly", NOT habits.

HABITS are recurring personal routines ("meditate", "drink water", "gym", "read 20 min").
Default is daily. If the user names specific weekdays ("gym on Mon, Wed and Fri",
"journal every weekday", "long run on Sundays"), set days to those weekday names
(lowercase 3-letter: mon,tue,wed,thu,fri,sat,sun); "every weekday" = mon-fri,
"weekends" = sat,sun. If daily or unspecified, OMIT days. One-off events with a
date are TODOS, not habits.

BUCKETS: every todo and habit also gets a "bucket" — which of the user's daily
pillars it serves:
${PILLARS.map((p) => `- "${p.id}": ${p.description}`).join("\n")}
If it's a pure chore or errand serving none of these (laundry, groceries, pay bill,
book cab), OMIT bucket. Bucket values in the JSON examples below are illustrative — always use one of the ids listed above, or omit.

REMINDERS: every dated task reminds the user by default (10 min before dueAt) — you
don't need to do anything for that. Only set alarmLeadMin to override the default:
- "remind me ... at 5pm" => alarmLeadMin: 0 (at the time)
- "remind me 30 min before X" => alarmLeadMin: 30
- "no reminder" / "don't remind me" / "silently" => alarmLeadMin: -1 (mutes it)
- Otherwise OMIT alarmLeadMin — the default reminder applies.

BATCH: if the input contains MULTIPLE distinct actionable items (a brain dump, a voice
note listing several things), return intent "batch" with items in the order mentioned.
Each item: kind "todo" (usual fields incl. bucket/dueAt/alarmLeadMin/recurrence) or
kind "habit" (emoji, days). Use batch only for 2+ items; a single item uses its normal
intent. Goal-sized items inside a dump stay as one todo item — don't expand them there.

CURIOSITY: when the input names a person or project that appears NOWHERE in the context
(open todos, habits, VAULT_CONTEXT, RECENT_LOGS) and knowing more would change how you
file it, use "clarify" with ONE short, curious question ("Who is Sam — a client or a
friend?"). Never interrogate routine items or chores. Separately: whenever the user's
message reveals a durable fact about a person or project ("Sam is a potential
client"), add remember:"<the fact in one line>" alongside your result — it gets
filed into their second brain.

GOALS vs TODOS — this matters: if the input is a GOAL or PROJECT — an outcome that
needs many work sessions ("launch the website", "get 10k followers", "build the
university", "write a book", "learn video editing") — do NOT create it as a single todo.
Return intent "breakdown" instead:
- message: ONE short, honest sentence telling the user this is a goal, not a task.
- subtasks: 2-4 concrete steps. The FIRST must be a physical next action startable
  within 24 hours ("Email 3 venues for quotes", never "Plan venues").
- If the user stated a deadline, give later subtasks dueAts spread BACKWARDS from that
  deadline as milestones. Otherwise omit dueAt.
Something completable in one focused sitting (~2h) is a todo, not a goal.

Decide intent from the user's free-form input:
- "todo" — a one-off OR recurring task. Infer urgent and important from wording, deadlines, and context.
   urgent = true only if the deadline is within ~7 days. If it's weeks/months out, urgent=false.
   If unclear, lean toward important=true urgent=false.
- "habit" — recurring routine. Pick a single relevant emoji; include days only if non-daily.
- "complete" — user is marking something done (e.g. "done with laundry", "finished the report"). Set match to the best-matching open todo or habit title.
- "delete" — user wants to remove something.
- "log" — a statement about something that HAPPENED (past tense, no action requested):
   "ate pav bhaji for dinner", "did 12 push-ups", "slept at 2am", "weight 74kg",
   "skipped the gym today". Keep note close to their words; set domain to
   food | fitness | sleep | other.
- "learning" — pasted content (a quote, thread, article excerpt, URL, or "learned that...")
   that is knowledge, not a task. Distill it to a crisp 1-2 sentence learning in plain words;
   set source to the URL or author if present. It gets filed into their second brain.
- "advice" — a QUESTION seeking guidance ("what should I eat tonight?", "should I train
   today?", "what should I focus on?"). Answer directly in 2-3 concrete sentences using
   FITNESS_FLOOR, RECENT_LOGS, and VAULT_CONTEXT below. Be specific, not generic —
   reference what they actually did/ate/planned. Never lecture.
- "floor_update" — they're changing their fitness floor ("update my floor: gym 5x",
   "make the walk 20 minutes", "add a sleep rule"). Merge the change into the CURRENT
   FITNESS_FLOOR and return the COMPLETE rewritten floor text plus a one-line message.
- "clarify" — only if the input is too ambiguous to act on. Ask ONE short, specific question.
- "unknown" — input is not actionable at all (small talk, gibberish). Briefly explain.

Be decisive. Prefer acting over asking. Only clarify if a key field genuinely cannot be guessed.

Return ONLY valid JSON matching one of these shapes:
{"intent":"todo","title":"...","urgent":true|false,"important":true|false,"bucket":"money","dueAt":"2026-06-29T17:00:00","alarmLeadMin":10,"surfaceAt":"2026-06-22T09:00:00","recurrence":"yearly","remember":"Sam is a potential client"}
{"intent":"batch","message":"Got 4 things from that.","items":[{"kind":"todo","title":"...","urgent":true,"important":true,"bucket":"money","dueAt":"2026-07-11T17:00:00","alarmLeadMin":10},{"kind":"habit","title":"Meditate","emoji":"🧘"}]}
{"intent":"habit","title":"...","emoji":"🧘","bucket":"movement"}
{"intent":"habit","title":"Gym","emoji":"🏋️","days":["mon","wed","fri"],"bucket":"movement"}
{"intent":"breakdown","goal":"Launch my portfolio site","message":"That's a goal, not a task — here's where it starts.","subtasks":[{"title":"List the 5 pages the site needs","urgent":true,"important":true,"bucket":"moonshot"},{"title":"Draft homepage copy","urgent":false,"important":true,"bucket":"moonshot","dueAt":"2026-07-20T09:00:00"}]}
{"intent":"complete","match":"<existing title>"}
{"intent":"delete","match":"<existing title>"}
{"intent":"log","note":"Ate pav bhaji for dinner","domain":"food"}
{"intent":"learning","learning":"...","source":"https://..."}
{"intent":"advice","reply":"..."}
{"intent":"floor_update","floor":"<complete rewritten floor>","message":"Floor updated — the walk is 20 minutes now."}
{"intent":"clarify","question":"..."}
{"intent":"unknown","message":"..."}`;

export const smartParse = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => Input.parse(d))
  .handler(async ({ data }) => {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("Missing GEMINI_API_KEY");
    const gateway = createAiProvider(key);
    const kv = getCfEnv().KAKA_KV;

    const ctx: string[] = [];
    if (data.openTodos?.length)
      ctx.push(`Open todos: ${data.openTodos.slice(0, 20).join("; ")}`);
    if (data.knownHabits?.length)
      ctx.push(`Habits: ${data.knownHabits.join("; ")}`);

    // Grounding for advice/log/floor intents: the current fitness floor, a
    // slice of the Obsidian vault (pushed up daily by the Mac bridge), and
    // the last few life logs. All best-effort — missing pieces just mean
    // less-grounded answers.
    if (kv) {
      try {
        const [floor, vault, stateRaw] = await Promise.all([
          kv.get(FLOOR_KEY),
          kv.get(VAULT_CONTEXT_KEY),
          kv.get("kaka:state:v1"),
        ]);
        if (floor) ctx.push(`FITNESS_FLOOR (their current minimum week):\n${floor.slice(0, 1500)}`);
        if (vault) ctx.push(`VAULT_CONTEXT (from their second brain):\n${vault.slice(0, 3000)}`);
        if (stateRaw) {
          const state = JSON.parse(stateRaw) as {
            history?: { ts: number; kind: string; title: string }[];
          };
          const logs = (state.history ?? [])
            .filter((e) => e.kind === "logged" || e.kind === "journal" || e.kind === "learning")
            .slice(0, 20)
            .map((e) => `${new Date(e.ts).toISOString().slice(0, 10)}: ${e.title}`);
          if (logs.length > 0) ctx.push(`RECENT_LOGS:\n${logs.join("\n")}`);
        }
      } catch {
        // grounding is optional
      }
    }

    const prompt = data.pending
      ? `CURRENT_DATETIME: ${new Date().toISOString()}\n\nEarlier the user said: "${data.pending.original}"\nYou asked: "${data.pending.question}"\nThey replied: "${data.text}"\n\nNow produce the final JSON action.`
      : `CURRENT_DATETIME: ${new Date().toISOString()}\n\nUser input: "${data.text}"\n\n${ctx.join("\n\n")}\n\nReturn JSON.`;

    const { text } = await generateText({
      model: gateway("gemini-2.5-flash"),
      system: SYSTEM,
      prompt,
      // Structured extraction doesn't need Gemini's (default-on) thinking
      // pass — disabling it roughly halves capture latency.
      providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } },
    });

    // Robust JSON extraction
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/i, "")
      .trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
      return {
        intent: "unknown",
        message: "I couldn't parse that — try rephrasing.",
      } satisfies SmartResult;
    }
    let result: SmartResult;
    try {
      result = JSON.parse(match[0]) as SmartResult;
    } catch {
      return {
        intent: "unknown",
        message: "I couldn't parse that — try rephrasing.",
      } satisfies SmartResult;
    }

    // Server-side effects for intents that own KV state: learnings (and
    // "remember" facts) queue up for the nightly SecondBrain filing; a floor
    // update replaces the floor.
    if (kv) {
      try {
        const toFile: StoredLearning[] = [];
        if (result.intent === "learning" && result.learning) {
          toFile.push({ ts: Date.now(), learning: result.learning, source: result.source });
        }
        if (result.remember) {
          toFile.push({ ts: Date.now(), learning: result.remember });
        }
        if (toFile.length > 0) {
          const raw = await kv.get(LEARNINGS_KEY);
          const list: StoredLearning[] = raw ? JSON.parse(raw) : [];
          await kv.put(LEARNINGS_KEY, JSON.stringify([...list, ...toFile].slice(-500)));
        }
        if (result.intent === "floor_update" && result.floor) {
          await kv.put(FLOOR_KEY, result.floor);
        }
      } catch (err) {
        console.error("Post-parse KV write failed:", err);
      }
    }
    return result;
  });

const CLASSIFY_SYSTEM = `Classify each item from a personal todo/habit app into one of the user's
daily pillars, or "none" for chores/errands that serve no pillar:
${PILLARS.map((p) => `- ${p.id}: ${p.description}`).join("\n")}
Return ONLY a JSON array: [{"id":"...","bucket":"${PILLARS.map((p) => p.id).join("|")}|none"}] — one entry per input item.`;

/** One-time sweep: bucket items created before buckets existed. Runs once per
 *  device after sync; every item gets a bucket (or "none"), so it never re-runs. */
export const classifyBuckets = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({ items: z.array(z.object({ id: z.string(), title: z.string() })).max(60) })
      .parse(d),
  )
  .handler(async ({ data }): Promise<Record<string, string>> => {
    const key = process.env.GEMINI_API_KEY;
    if (!key || data.items.length === 0) return {};
    const gateway = createAiProvider(key);
    const { text } = await generateText({
      model: gateway("gemini-2.5-flash"),
      system: CLASSIFY_SYSTEM,
      prompt: JSON.stringify(data.items),
      providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } },
    });
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return {};
    try {
      const arr = JSON.parse(match[0]) as { id: string; bucket: string }[];
      return Object.fromEntries(arr.map((r) => [r.id, r.bucket]));
    } catch {
      return {};
    }
  });
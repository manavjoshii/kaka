import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getCfEnv } from "./cf-context.server";

const SYNC_KEY = "kaka:state:v1";
const SNAPSHOT_MARKER_KEY = "kaka:snapshot-last";
const SNAPSHOT_TTL_SECONDS = 30 * 24 * 60 * 60;

const StateSchema = z.object({
  todos: z.array(z.any()),
  habits: z.array(z.any()),
  // Legacy blobs may still carry stats (the old XP/level system); tolerated, ignored.
  stats: z.object({ xp: z.number(), level: z.number() }).optional(),
  /** Activity log, merged by event id across devices. */
  history: z.array(z.any()).optional(),
  /** Today's focus picks from the morning ritual. */
  focus: z.object({ date: z.string(), ids: z.array(z.string()) }).optional(),
  /** IANA timezone of the last device that pushed — used by the reminder
   *  cron to format times the way the user reads them. */
  tz: z.string().optional(),
  updatedAt: z.number(),
});

export type SyncedState = z.infer<typeof StateSchema>;

// Single-user app gated by a shared site password, so a fixed KV key is fine
// — there's no multi-tenant identity to namespace by.
export const pullState = createServerFn({ method: "GET" }).handler(async () => {
  const kv = getCfEnv().KAKA_KV;
  if (!kv) return null; // no KV bound (e.g. local dev) — sync disabled
  const raw = await kv.get(SYNC_KEY);
  if (!raw) return null;
  try {
    return StateSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
});

export const pushState = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => StateSchema.parse(d))
  .handler(async ({ data }) => {
    const kv = getCfEnv().KAKA_KV;
    if (!kv) return { synced: false };

    // Once a day, keep a dated copy for 30 days before overwriting the live
    // state — sync is last-write-wins, so this caps the damage of any bad
    // push (stale device, bug) at a single day of edits.
    const today = new Date().toISOString().slice(0, 10);
    try {
      const lastSnapshot = await kv.get(SNAPSHOT_MARKER_KEY);
      if (lastSnapshot !== today) {
        const current = await kv.get(SYNC_KEY);
        if (current) {
          await kv.put(`kaka:snapshot:${today}`, current, {
            expirationTtl: SNAPSHOT_TTL_SECONDS,
          });
        }
        await kv.put(SNAPSHOT_MARKER_KEY, today);
      }
    } catch {
      // snapshot is best-effort insurance; never block the actual sync
    }

    await kv.put(SYNC_KEY, JSON.stringify(data));
    return { synced: true };
  });

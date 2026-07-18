import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { readSubs, writeSubs, sendPushToAll, type StoredSub } from "./push.server";

const SubInput = z.object({
  endpoint: z.string().url(),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
  label: z.string().optional(),
});

export const savePushSub = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => SubInput.parse(d))
  .handler(async ({ data }) => {
    const subs = await readSubs();
    const next: StoredSub[] = [
      ...subs.filter((s) => s.endpoint !== data.endpoint),
      {
        endpoint: data.endpoint,
        expirationTime: data.expirationTime ?? null,
        keys: data.keys,
        label: data.label,
        addedAt: Date.now(),
      },
    ];
    await writeSubs(next);
    return { saved: true, devices: next.length };
  });

/** Fires a real notification through the full pipeline so the user can
 *  confirm reminders work on this device right after enabling them. */
export const sendTestPush = createServerFn({ method: "POST" }).handler(async () => {
  return sendPushToAll({
    title: "Kaka reminders are on 🐤",
    body: "This is how a task reminder will look.",
    tag: "test",
  });
});

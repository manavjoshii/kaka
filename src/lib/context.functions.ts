import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getCfEnv } from "./cf-context.server";
import { FLOOR_KEY } from "./parse.functions";

/** The fitness floor — the user's minimum acceptable week, as plain text.
 *  Read by the AI (advice, floor updates) and the weekly review; editable
 *  here from settings or via the composer ("update my floor: ..."). */
export const getFloor = createServerFn({ method: "GET" }).handler(async () => {
  const kv = getCfEnv().KAKA_KV;
  if (!kv) return null;
  return kv.get(FLOOR_KEY);
});

export const saveFloor = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ floor: z.string().max(4000) }).parse(d))
  .handler(async ({ data }) => {
    const kv = getCfEnv().KAKA_KV;
    if (!kv) return { saved: false };
    await kv.put(FLOOR_KEY, data.floor.trim());
    return { saved: true };
  });

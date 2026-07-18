import { useNitroHooks } from "nitro/app";
import { deliverDueAlarms } from "./lib/push.server";

// Cron entry point (see triggers in vite.config.ts): every 5 minutes,
// Cloudflare invokes the Worker's `scheduled` handler. Nitro owns that
// handler (our src/server.ts fetch wrapper never sees it) and re-emits it as
// the `cloudflare:scheduled` hook — with globalThis.__env__ already set, so
// KV and secrets resolve exactly like in a normal request.
export default function scheduledPlugin() {
  useNitroHooks().hook(
    "cloudflare:scheduled" as never,
    (({ context }: { context: { waitUntil(p: Promise<unknown>): void } }) => {
      context.waitUntil(deliverDueAlarms());
    }) as never,
  );
}

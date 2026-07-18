// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  // KV namespace for cross-device sync (see src/lib/sync.functions.ts).
  nitro: {
    // Reminder cron: hooks cloudflare:scheduled to push due alarms.
    plugins: ["./src/nitro-scheduled.ts"],
    cloudflare: {
      wrangler: {
        // Your Worker's name — the app deploys to <name>.<your-subdomain>.workers.dev
        name: "kaka",
        // Create your own namespace (npx wrangler kv namespace create KAKA_KV)
        // and paste its id here — see README "Set up" step 3.
        kv_namespaces: [{ binding: "KAKA_KV", id: "PASTE_YOUR_KV_NAMESPACE_ID" }],
        // Reminder delivery: the cron checks for due alarms every 5 minutes.
        triggers: { crons: ["*/5 * * * *"] },
      },
    },
  },
});

// Minimal shape we use — avoids depending on @cloudflare/workers-types.
export type MinimalKVNamespace = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};

export type CfEnv = {
  KAKA_KV?: MinimalKVNamespace;
  GEMINI_API_KEY?: string;
  SITE_PASSWORD?: string;
  VAPID_PRIVATE_KEY?: string;
  GHAR_ADMIN_CODE?: string;
};

// Nitro's own Cloudflare module handler (the real per-request Worker entry —
// see node_modules/nitro/dist/presets/cloudflare/runtime/_module-handler.mjs)
// sets `globalThis.__env__ = env` unconditionally at the very start of every
// request, before any of our own routing runs. That's the unmodified
// Cloudflare bindings object (KV namespaces, secrets, etc). Reading it here
// is more reliable than trying to thread `env` through our own server.ts ->
// TanStack Start -> server-function call chain ourselves: by the time a
// createServerFn handler runs, whatever `env` our own code was handed along
// the way has already lost non-string bindings like KV namespaces somewhere
// in that chain. globalThis is shared across all build chunks within the
// same Worker isolate, so this works regardless of how the code got split.
export function getCfEnv(): CfEnv {
  return (globalThis as unknown as { __env__?: CfEnv }).__env__ ?? {};
}

import { createHash } from "node:crypto";

import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { getCfEnv } from "./lib/cf-context.server";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!body.includes('"unhandled":true') || !body.includes('"message":"HTTPError"')) {
    return response;
  }

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

const AUTH_COOKIE = "kaka_auth";
const AUTH_PATH = "/__auth";

function authToken(password: string): string {
  return createHash("sha256").update(password).digest("hex");
}

function hasValidCookie(request: Request, password: string): boolean {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const match = cookieHeader.match(new RegExp(`${AUTH_COOKIE}=([^;]+)`));
  return match?.[1] === authToken(password);
}

function loginPageHtml(error?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Kaka</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:#fbf9f5; font-family:system-ui,sans-serif; color:#3a342c;
    -webkit-font-smoothing:antialiased; }
  form { background:#fff; border:1px solid #e9e3d5; border-radius:20px; padding:2.4rem 2.4rem 2.1rem;
    width:300px; box-shadow:0 24px 60px rgba(58,52,44,0.10), 0 2px 8px rgba(58,52,44,0.05);
    text-align:center; }
  h1 { font-size:1.6rem; letter-spacing:-0.02em; margin:0; font-weight:700; }
  h1 i { font-style:normal; color:#e8a020; }
  .tag { color:#97907f; font-size:0.8rem; margin:0.3rem 0 1.5rem; }
  input { width:100%; box-sizing:border-box; padding:0.7rem 0.85rem; border-radius:12px;
    border:1px solid #ddd6c6; font-size:0.95rem; margin-bottom:0.75rem; outline:none;
    text-align:center; transition:border-color .15s, box-shadow .15s; background:#fdfcf9; }
  input:focus { border-color:#e8a020; box-shadow:0 0 0 3px rgba(232,160,32,0.15); }
  button { width:100%; padding:0.7rem; border:none; border-radius:12px; background:#3a342c;
    color:#fbf9f5; font-size:0.95rem; font-weight:600; cursor:pointer; transition:opacity .15s; }
  button:hover { opacity:0.9; }
  .err { color:#b3432b; font-size:0.82rem; margin:-0.2rem 0 0.75rem; }
</style>
</head>
<body>
  <form method="POST" action="${AUTH_PATH}">
    <h1>Kaka<i>.</i></h1>
    <p class="tag">your day, in one sentence</p>
    ${error ? `<p class="err">${error}</p>` : ""}
    <input type="password" name="password" placeholder="Password" autofocus />
    <button type="submit">Enter</button>
  </form>
</body>
</html>`;
}

// Automation bridge endpoints — plug Kaka into your own scripts and tools
// (e.g. pull daily digests into an Obsidian vault, push personal context for
// the AI). They bypass the cookie-based auth gate in favor of a ?key= query
// param checked against the same site password.
function keyGate(url: URL): Response | null {
  const password = process.env.SITE_PASSWORD;
  if (password && url.searchParams.get("key") !== password) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return null;
}

async function handleReviewRequest(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/review" || request.method !== "GET") return null;
  const denied = keyGate(url);
  if (denied) return denied;

  const kv = getCfEnv().KAKA_KV;
  const raw = kv ? await kv.get("kaka:review-latest") : null;
  return new Response(raw ?? JSON.stringify({ review: null }), {
    headers: { "content-type": "application/json" },
  });
}

// GET /api/digest?key=&date=YYYY-MM-DD — one day of activity as markdown
// (ready for a notes app or journal), plus the queued learnings. The date is
// interpreted in the user's timezone (synced up from their devices).
async function handleDigestRequest(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/digest" || request.method !== "GET") return null;
  const denied = keyGate(url);
  if (denied) return denied;

  const date = url.searchParams.get("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return new Response(JSON.stringify({ error: "date=YYYY-MM-DD required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const kv = getCfEnv().KAKA_KV;
  if (!kv) {
    return new Response(JSON.stringify({ date, markdown: "", learnings: [] }), {
      headers: { "content-type": "application/json" },
    });
  }

  const [stateRaw, learningsRaw] = await Promise.all([
    kv.get("kaka:state:v1"),
    kv.get("kaka:learnings:v1"),
  ]);
  type Ev = { ts: number; kind: string; title: string; meta?: Record<string, unknown> };
  let history: Ev[] = [];
  let tz = "UTC";
  try {
    const state = stateRaw ? (JSON.parse(stateRaw) as { history?: Ev[]; tz?: string }) : {};
    history = state.history ?? [];
    if (state.tz) tz = state.tz;
  } catch {
    // empty digest below
  }

  const localDate = (ts: number) => new Date(ts).toLocaleDateString("en-CA", { timeZone: tz });
  const dayEvents = history.filter((e) => localDate(e.ts) === date).sort((a, b) => a.ts - b.ts);

  const section = (title: string, kinds: string[], format?: (e: Ev) => string) => {
    const evs = dayEvents.filter((e) => kinds.includes(e.kind));
    if (evs.length === 0) return "";
    const lines = evs.map((e) => `- ${format ? format(e) : e.title}`);
    return `\n## ${title}\n${lines.join("\n")}\n`;
  };

  let markdown = "";
  if (dayEvents.length > 0) {
    markdown =
      `# ${date} — Kaka daily\n` +
      section("Planned", ["day_planned"], (e) => {
        const titles = (e.meta?.titles as string[]) ?? [];
        return titles.length ? titles.join("; ") : e.title;
      }) +
      section("Done", ["todo_completed"], (e) =>
        e.meta?.bucket && e.meta.bucket !== "none" ? `${e.title} (${e.meta.bucket})` : e.title,
      ) +
      section("Habits", ["habit_checkin"], (e) => `${e.meta?.emoji ?? ""} ${e.title}`.trim()) +
      section("Logged", ["logged"]) +
      section("Journal", ["journal"]) +
      section("Learnings captured", ["learning"]) +
      section("Added", ["todo_created", "habit_created"]) +
      section("Day close", ["day_review"]);
  }

  let learnings: unknown[] = [];
  try {
    learnings = learningsRaw ? JSON.parse(learningsRaw) : [];
  } catch {
    // none
  }

  return new Response(JSON.stringify({ date, markdown, learnings }), {
    headers: { "content-type": "application/json" },
  });
}

// POST /api/context?key= — push a compact slice of personal context (goals,
// projects, notes from your own tools) so the AI's answers know who it's
// talking to. Plain text body, capped.
async function handleContextPush(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/context" || request.method !== "POST") return null;
  const denied = keyGate(url);
  if (denied) return denied;

  const kv = getCfEnv().KAKA_KV;
  if (!kv) return new Response(JSON.stringify({ saved: false }), { status: 503 });
  const body = (await request.text()).slice(0, 12000);
  await kv.put("kaka:vault-context:v1", body);
  return new Response(JSON.stringify({ saved: true, bytes: body.length }), {
    headers: { "content-type": "application/json" },
  });
}

async function checkAuth(request: Request): Promise<Response | null> {
  const password = process.env.SITE_PASSWORD;
  if (!password) return null; // no password configured — auth disabled

  const url = new URL(request.url);

  if (url.pathname === AUTH_PATH && request.method === "POST") {
    const form = await request.formData();
    const supplied = String(form.get("password") ?? "");
    if (supplied === password) {
      return new Response(null, {
        status: 302,
        headers: {
          location: "/",
          "set-cookie": `${AUTH_COOKIE}=${authToken(password)}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax; Secure`,
        },
      });
    }
    return new Response(loginPageHtml("Wrong password."), {
      status: 401,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  if (hasValidCookie(request, password)) return null;

  return new Response(loginPageHtml(), {
    status: 401,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// The hashed JS/CSS in /assets/* are correctly cached immutable+1yr (a new
// deploy gets new hashes, so that's safe). The HTML *document* itself had no
// cache-control at all, which leaves browsers to guess — and iOS Safari's
// "Add to Home Screen" standalone mode in particular is known to hang onto a
// stale document far longer than a regular browser tab unless told not to.
// Force every HTML response to revalidate so a new deploy is picked up the
// next time the app is opened, not just on the next manual hard-refresh.
function withNoCacheHtml(response: Response): Response {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) return response;
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-cache, must-revalidate");
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    const bridgeResponse =
      (await handleReviewRequest(request)) ??
      (await handleDigestRequest(request)) ??
      (await handleContextPush(request));
    if (bridgeResponse) return bridgeResponse;

    const authResponse = await checkAuth(request);
    if (authResponse) return authResponse;

    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return withNoCacheHtml(await normalizeCatastrophicSsrResponse(response));
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },

};
// Reminder cron lives in src/nitro-scheduled.ts (a nitro runtime plugin) —
// nitro owns the Worker's `scheduled` handler, not this module.

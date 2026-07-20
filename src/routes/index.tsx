import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { AnimatePresence, motion, useDragControls } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import {
  STORAGE_KEYS,
  BUCKETS,
  BUCKET_META,
  computeStreak,
  daysLabel,
  DAY_LETTERS,
  getLastModified,
  habitScheduledOn,
  lastNDays,
  setLastModified,
  todayISO,
  uid,
  useLocal,
  type Bucket,
  type Focus,
  type Habit,
  type Recurrence,
  type Todo,
} from "@/lib/store";
import { DEFAULT_USERNAME, KEYSTONE_PILLAR } from "@/config";
import { celebrate } from "@/lib/celebrate";
import { smartParse, classifyBuckets, type SmartResult, type BatchItem } from "@/lib/parse.functions";
import { pullState, pushState } from "@/lib/sync.functions";
import { getSettings, saveSettings, getTodayEvents, type CalendarEvent } from "@/lib/calendar.functions";
import { getFloor, saveFloor } from "@/lib/context.functions";
import { getWeeklyReview, type WeeklyReview } from "@/lib/review.functions";
import { savePushSub, sendTestPush } from "@/lib/push.functions";
import { registerServiceWorker, subscribeToPush } from "@/lib/push-browser";
import {
  appendHistory,
  useHistory,
  readHistory,
  mergeHistory,
  downloadHistory,
  downloadHistoryJSON,
  clearHistory,
  kindLabel,
  KIND_CATEGORIES,
  type HistoryEvent,
  type HistoryKind,
} from "@/lib/history";
import { renderHeaderQuote, pickFooterQuote, smartSuggestions } from "@/lib/quotes";
import {
  Check,
  Calendar,
  Clock,
  Flame,
  Loader2,
  Mic,
  MicOff,
  Send,
  Sparkles,
  Sun,
  CalendarClock,
  Archive,
  Trash2,
  Hourglass,
  Repeat,
  History as HistoryIcon,
  Download,
  Pencil,
  Move,
  Bell,
  BellOff,
  Moon,
  Target,
  Settings as SettingsIcon,
  Plus,
} from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Kaka — smart to-dos & habits" },
      {
        name: "description",
        content:
          "Smart to-dos and habits. Type or speak — Kaka schedules, reminds, and files your day.",
      },
    ],
  }),
  component: HomePage,
});

type Pending = { original: string; question: string } | null;

// The Eisenhower matrix, folded to what a solo user actually acts on:
// Do now (urgent+important), Schedule (important), Later (everything else —
// the old delegate/drop quadrants, which never earned their screen space).
type Quadrant = "do" | "schedule" | "later";

// Recurring tasks (e.g. "every week") are calendar-driven, not
// importance-driven — they auto-surface in Schedule 1-2 days before their
// due date and move to Do now on the day itself, overriding whatever
// urgent/important was last set on them.
function quadrantOf(t: Todo, now = Date.now()): Quadrant {
  if (t.dueAt) {
    const endOfToday = new Date(now);
    endOfToday.setHours(23, 59, 59, 999);
    if (t.dueAt <= endOfToday.getTime()) return "do"; // due today or overdue → always urgent
    if (t.recurrence) return "schedule"; // recurring but not today → schedule
  }
  if (t.urgent && t.important) return "do";
  if (t.important) return "schedule";
  return "later";
}

// Untouched, undated tasks in Later quietly go stale after 3 weeks — the app
// offers a one-tap sweep instead of letting them pile up as guilt.
const STALE_MS = 21 * 86400000;
function isStale(t: Todo, now = Date.now()): boolean {
  return !t.dueAt && !t.recurrence && now - t.createdAt > STALE_MS;
}

function normalizeBucket(b?: string): Bucket | "none" {
  return (BUCKETS as string[]).includes(b ?? "") ? (b as Bucket) : "none";
}

/** The shape both the "todo" intent and proposal items share. */
type ParsedTodo = {
  title: string;
  urgent: boolean;
  important: boolean;
  dueAt?: string;
  surfaceAt?: string;
  recurrence?: Recurrence;
  alarmLeadMin?: number;
  bucket?: string;
};

/** One row in a proposal card — a todo, or a habit from a batch dump. */
type ProposalItem = ParsedTodo & { kind?: "todo" | "habit"; emoji?: string; days?: string[] };

// Proposal card state: "goal" = a goal-sized capture broken into first moves;
// "batch" = a brain dump split into its individual items.
type Proposal = {
  mode: "goal" | "batch";
  goal?: string;
  subtasks: ProposalItem[];
  added: number[];
};

// Kaka's suggested morning picks: overdue and due-today first, then the most
// pressing important work — and always at least one keystone-pillar item when
// one exists (the rule: every day contains keystone work; see src/config.ts).
function suggestPicks(cands: Todo[]): string[] {
  const now = Date.now();
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  const scored = cands
    .map((t) => {
      let s = 0;
      const q = quadrantOf(t);
      if (q === "do") s += 50;
      else if (q === "schedule") s += 25;
      if (t.dueAt) {
        if (t.dueAt <= endOfToday.getTime()) s += 100;
        else s += Math.max(0, 40 - Math.floor((t.dueAt - now) / 86400000) * 8);
      }
      s += Math.min(10, Math.floor((now - t.createdAt) / 86400000));
      return { t, s };
    })
    .sort((a, b) => b.s - a.s);
  const picks = scored.slice(0, 3);
  if (
    KEYSTONE_PILLAR &&
    picks.length === 3 &&
    !picks.some((p) => p.t.bucket === KEYSTONE_PILLAR)
  ) {
    const m = scored.slice(3).find((p) => p.t.bucket === KEYSTONE_PILLAR);
    if (m) picks[2] = m;
  }
  return picks.map((p) => p.t.id);
}

// Recurring tasks without an explicit surfaceAt default to surfacing 2 days
// before they're due, so they don't clutter the matrix the rest of the week.
function effectiveSurfaceAt(t: Todo): number | undefined {
  if (t.surfaceAt) return t.surfaceAt;
  if (t.recurrence && t.dueAt) return t.dueAt - 2 * 86400000;
  return undefined;
}

const QUADRANT_FLAGS: Record<Quadrant, { urgent: boolean; important: boolean }> = {
  do: { urgent: true, important: true },
  schedule: { urgent: false, important: true },
  later: { urgent: false, important: false },
};

const QUADRANT_ORDER: Quadrant[] = ["do", "schedule", "later"];

const QUADRANT_META: Record<
  Quadrant,
  { label: string; sub: string; icon: typeof Sun; tint: string; chip: string; ring: string }
> = {
  do: {
    label: "Do now",
    sub: "Urgent · Important",
    icon: Sun,
    tint: "bg-rose/10 border-rose/30",
    chip: "bg-rose/15 text-rose",
    ring: "ring-rose/40",
  },
  schedule: {
    label: "Schedule",
    sub: "Important · Not urgent",
    icon: CalendarClock,
    tint: "bg-sky/10 border-sky/30",
    chip: "bg-sky/15 text-sky",
    ring: "ring-sky/40",
  },
  later: {
    label: "Later",
    sub: "Everything else",
    icon: Archive,
    tint: "bg-surface border-border",
    chip: "bg-surface-2 text-muted-foreground",
    ring: "ring-border",
  },
};

function formatDue(ts: number): { label: string; tone: "overdue" | "today" | "soon" | "later" } {
  const now = new Date();
  const d = new Date(ts);
  const diffMs = d.getTime() - now.getTime();
  const diffMin = Math.round(diffMs / 60000);
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow =
    d.getFullYear() === tomorrow.getFullYear() &&
    d.getMonth() === tomorrow.getMonth() &&
    d.getDate() === tomorrow.getDate();
  const timeStr = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (diffMs < 0) {
    if (sameDay) return { label: `Overdue · ${timeStr}`, tone: "overdue" };
    return { label: `Overdue · ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`, tone: "overdue" };
  }
  if (sameDay) {
    if (diffMin < 60) return { label: `In ${Math.max(1, diffMin)} min`, tone: "today" };
    return { label: `Today · ${timeStr}`, tone: "today" };
  }
  if (isTomorrow) return { label: `Tomorrow · ${timeStr}`, tone: "soon" };
  const diffDays = Math.round(diffMs / 86400000);
  if (diffDays < 7)
    return {
      label: `${d.toLocaleDateString("en-US", { weekday: "short" })} · ${timeStr}`,
      tone: "soon",
    };
  return {
    label: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    tone: "later",
  };
}

function toLocalInputValue(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function advanceRecurring(t: Todo): Todo {
  if (!t.recurrence || !t.dueAt) return t;
  const next = new Date(t.dueAt);
  if (t.recurrence === "yearly") next.setFullYear(next.getFullYear() + 1);
  else if (t.recurrence === "monthly") next.setMonth(next.getMonth() + 1);
  else if (t.recurrence === "weekly") next.setDate(next.getDate() + 7);
  const newDue = next.getTime();
  const lead = t.surfaceAt ? t.dueAt - t.surfaceAt : 0;
  return { ...t, dueAt: newDue, surfaceAt: lead > 0 ? newDue - lead : undefined };
}

function HomePage() {
  const [todos, setTodos] = useLocal<Todo[]>(STORAGE_KEYS.todos, []);
  const [habits, setHabits] = useLocal<Habit[]>(STORAGE_KEYS.habits, []);
  const [username, setUsername] = useLocal<string>("kaka.username.v1", DEFAULT_USERNAME);
  const [editingName, setEditingName] = useState(false);
  const [focus, setFocus] = useLocal<Focus>(STORAGE_KEYS.focus, { date: "", ids: [] });
  // History lives behind Settings — the main screen is for today, not the log.
  const [showHistory, setShowHistory] = useLocal<boolean>("kaka.history-visible.v1", false);
  const history = useHistory();

  // Push reminders are delivered through this worker; registering is cheap
  // and idempotent, and keeps an existing subscription alive.
  useEffect(() => {
    registerServiceWorker();
  }, []);

  // Starts false to match SSR; a blocking inline script in __root.tsx already
  // set the real class on <html> before hydration, so this just reads it back
  // after mount (see sessionSeed/speechSupported above for why not sooner).
  const [darkMode, setDarkMode] = useState(false);
  useEffect(() => {
    setDarkMode(document.documentElement.classList.contains("dark"));
  }, []);
  function toggleDarkMode() {
    const next = !darkMode;
    setDarkMode(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("kaka.theme.v1", next ? "dark" : "light");
  }

  // Cross-device sync: pull on load (adopt remote if it's newer than this
  // device's last local edit), then push debounced on every local change.
  const [synced, setSynced] = useState(false);
  const pullRemote = useServerFn(pullState);
  const pushRemote = useServerFn(pushState);

  useEffect(() => {
    (async () => {
      try {
        const remote = await pullRemote();
        if (remote) {
          // History merges by event id regardless of which state is newer —
          // captures from the phone and the laptop are both kept.
          mergeHistory((remote.history ?? []) as HistoryEvent[]);
        }
        if (remote && remote.updatedAt > getLastModified()) {
          setTodos(remote.todos as Todo[]);
          setHabits(remote.habits as Habit[]);
          if (remote.focus) setFocus(remote.focus as Focus);
          setLastModified(remote.updatedAt);
        }
      } catch (e) {
        console.error("Sync pull failed:", e);
      } finally {
        setSynced(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!synced) return;
    const t = setTimeout(() => {
      const now = Date.now();
      setLastModified(now);
      pushRemote({
        data: {
          todos,
          habits,
          focus,
          history: readHistory(),
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
          updatedAt: now,
        },
      }).catch((e) => console.error("Sync push failed:", e));
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todos, habits, focus, history, synced]);
  // Picked once per session, frozen until the next reload/reopen. Starts at
  // 0 (deterministic) so server-render and the first client render match —
  // Date.now() would differ between SSR and hydration and trigger a
  // hydration-mismatch error, which forces React to throw away the
  // server-rendered DOM and do a full client re-render (slow, especially on
  // weaker phones). The real seed is set client-side after mount instead.
  const [sessionSeed, setSessionSeed] = useState(0);
  // Composer suggestions: a fixed set for this session, derived from time of
  // day + past captures. Each one is a single click away from being added.
  // Recomputed together with sessionSeed once the real client time is known.
  const [suggestions, setSuggestions] = useState<string[]>(() => smartSuggestions(new Date(0), []));
  useEffect(() => {
    const now = Date.now();
    setSessionSeed(now);
    const recentInputs = history.filter((e) => e.kind === "captured").map((e) => e.title);
    setSuggestions(smartSuggestions(new Date(now), recentInputs));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const headerQuote = renderHeaderQuote(username, Math.floor(sessionSeed / 30000));
  const footerQuote = pickFooterQuote(Math.floor(sessionSeed / 60_000));

  const today = todayISO();

  // Morning/evening ritual visibility. Both start hidden (SSR-safe) and are
  // resolved client-side from localStorage — each shows at most once a day.
  const [planDone, setPlanDone] = useState(true);
  const [shutdownDone, setShutdownDone] = useState(true);
  useEffect(() => {
    setPlanDone(localStorage.getItem("kaka.plan.v1") === today);
    setShutdownDone(localStorage.getItem("kaka.shutdown.v1") === today);
  }, [today]);

  // Today's calendar events (only if a calendar URL is configured — the
  // server returns null otherwise). The client passes its own local-midnight
  // window so "today" is decided in the user's timezone, not the server's.
  const fetchEvents = useServerFn(getTodayEvents);
  const [calEvents, setCalEvents] = useState<CalendarEvent[] | null>(null);
  useEffect(() => {
    if (!synced) return;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    fetchEvents({ data: { startMs: start.getTime(), endMs: start.getTime() + 86400000 } })
      .then((evts) => setCalEvents(evts))
      .catch((e) => console.error("Calendar fetch failed:", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [synced]);

  // Weekly review: generated (and cached in KV) on first load each week,
  // shown until dismissed. Fetch even when dismissed so the /api/review
  // export endpoint always has the latest one.
  const fetchReview = useServerFn(getWeeklyReview);
  const [review, setReview] = useState<WeeklyReview | null>(null);
  const [reviewDismissed, setReviewDismissed] = useState(true);
  useEffect(() => {
    if (!synced) return;
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday
    const weekOf = todayISO(d);
    const prevMonday = new Date(d);
    prevMonday.setDate(d.getDate() - 7);
    setReviewDismissed(localStorage.getItem("kaka.review.v1") === weekOf);
    fetchReview({
      data: { weekOf, startMs: prevMonday.getTime(), endMs: d.getTime() },
    })
      .then((r) => setReview(r))
      .catch((e) => console.error("Weekly review failed:", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [synced]);

  // One-time backfill: items created before buckets existed get classified in
  // a single AI call. Afterwards every item carries a bucket (or "none"), so
  // this finds nothing and goes quiet.
  const classify = useServerFn(classifyBuckets);
  const bucketSweepRan = useRef(false);
  useEffect(() => {
    if (!synced || bucketSweepRan.current) return;
    const items = [
      ...todos.filter((t) => !t.done && !t.bucket).map((t) => ({ id: t.id, title: t.title })),
      ...habits.filter((h) => !h.bucket).map((h) => ({ id: h.id, title: h.title })),
    ].slice(0, 60);
    if (items.length === 0) return;
    bucketSweepRan.current = true;
    classify({ data: { items } })
      .then((map) => {
        if (!map || Object.keys(map).length === 0) return;
        setTodos((prev) =>
          prev.map((t) => (map[t.id] ? { ...t, bucket: normalizeBucket(map[t.id]) } : t)),
        );
        setHabits((prev) =>
          prev.map((h) => (map[h.id] ? { ...h, bucket: normalizeBucket(map[h.id]) } : h)),
        );
      })
      .catch((e) => console.error("Bucket sweep failed:", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [synced, todos, habits]);
  const parse = useServerFn(smartParse);

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [assistant, setAssistant] = useState<string | null>(null);
  const [breakdown, setBreakdown] = useState<Proposal | null>(null);
  const [filing, setFiling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Drop-zone rects for drag-and-drop quadrant reassignment — each
  // QuadrantCard registers its container element here on mount.
  const quadrantRefs = useRef<Partial<Record<Quadrant, HTMLDivElement>>>({});

  // Voice
  const [listening, setListening] = useState(false);
  const recogRef = useRef<any>(null);
  // Starts false to match SSR (no window), then flips client-side after
  // mount. Checking this synchronously in render — true on first client
  // render, false during SSR — caused a hydration mismatch (the mic button
  // would be present client-side but absent in the server-rendered HTML).
  const [speechSupported, setSpeechSupported] = useState(false);
  useEffect(() => {
    setSpeechSupported("webkitSpeechRecognition" in window || "SpeechRecognition" in window);
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, [pending]);

  function startVoice() {
    if (!speechSupported) return;
    const Ctor: any =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const rec = new Ctor();
    // Continuous: long brain dumps shouldn't be cut off at the first pause —
    // recording runs until the mic is tapped again.
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    rec.onresult = (e: any) => {
      let txt = "";
      for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
      setInput(txt);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recogRef.current = rec;
    setListening(true);
    rec.start();
  }

  function stopVoice() {
    recogRef.current?.stop();
    setListening(false);
  }

  async function submit(overrideText?: string) {
    const text = (overrideText ?? input).trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    setAssistant(null);
    setBreakdown(null);
    // Optimistic: the text leaves the box instantly and a quiet "filing…"
    // line takes over — entry feels immediate even though the AI takes a
    // couple of seconds. On failure the text comes back untouched.
    setInput("");
    setFiling(text);
    appendHistory({ kind: "captured", title: text });
    try {
      const res = (await parse({
        data: {
          text,
          pending: pending ?? undefined,
          openTodos: todos.filter((t) => !t.done).map((t) => t.title),
          knownHabits: habits.map((h) => h.title),
        },
      })) as SmartResult;
      handleResult(res, text);
    } catch (e: any) {
      setError(e?.message ?? "Something went wrong.");
      setInput(text);
    } finally {
      setBusy(false);
      setFiling(null);
    }
  }

  /** Creates a todo from an AI-parsed shape (the "todo" intent or a breakdown
   *  subtask) and returns the confirmation message. */
  function addTodoFromParsed(p: ParsedTodo): string {
    const dueAt = p.dueAt ? new Date(p.dueAt).getTime() : undefined;
    let surfaceAt = p.surfaceAt ? new Date(p.surfaceAt).getTime() : undefined;
    // Safety: if AI forgot but the due is far away, hide it until 7 days before.
    if (!surfaceAt && dueAt && dueAt - Date.now() > 7 * 86400000) {
      surfaceAt = dueAt - 7 * 86400000;
    }
    const bucket = normalizeBucket(p.bucket);
    const hasDue = Number.isFinite(dueAt as number);
    // Reminders default on for dated tasks: 10 min before unless the AI passed
    // an explicit lead (or -1, meaning the user asked for no reminder).
    const alarmLeadMin = hasDue
      ? typeof p.alarmLeadMin === "number"
        ? p.alarmLeadMin
        : 10
      : undefined;
    setTodos((prev) => [
      {
        id: uid(),
        title: p.title,
        done: false,
        urgent: p.urgent,
        important: p.important,
        priority: p.urgent && p.important ? "high" : p.important ? "med" : "low",
        createdAt: Date.now(),
        dueAt: hasDue ? (dueAt as number) : undefined,
        surfaceAt: Number.isFinite(surfaceAt as number) ? (surfaceAt as number) : undefined,
        recurrence: p.recurrence,
        alarmLeadMin,
        bucket,
      },
      ...prev,
    ]);
    const alarmNote =
      alarmLeadMin != null && alarmLeadMin >= 0
        ? ` · 🔔 ${alarmLeadMin === 0 ? "at time" : `${alarmLeadMin}m before`}`
        : "";
    const dueNote = hasDue ? ` · ${formatDue(dueAt as number).label}${alarmNote}` : "";
    const where =
      surfaceAt && surfaceAt > Date.now()
        ? `Upcoming · surfaces ${formatDue(surfaceAt).label}`
        : QUADRANT_META[quadrantOf({ urgent: p.urgent, important: p.important } as Todo)].label;
    const recNote = p.recurrence ? ` · repeats ${p.recurrence}` : "";
    appendHistory({
      kind: "todo_created",
      title: p.title,
      meta: {
        urgent: p.urgent,
        important: p.important,
        bucket,
        quadrant: quadrantOf({ urgent: p.urgent, important: p.important } as Todo),
        dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
        surfaceAt: surfaceAt ? new Date(surfaceAt).toISOString() : undefined,
        recurrence: p.recurrence,
      },
    });
    return `Added "${p.title}" → ${where}${dueNote}${recNote}`;
  }

  /** Creates a habit from an AI-parsed shape and returns the confirmation. */
  function addHabitFromParsed(p: {
    title: string;
    emoji?: string;
    days?: string[];
    bucket?: string;
  }): string {
    const DAY_INDEX: Record<string, number> = {
      sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
    };
    const days = p.days
      ?.map((d) => DAY_INDEX[d.slice(0, 3).toLowerCase()])
      .filter((n): n is number => n !== undefined);
    const normalized = days && days.length > 0 && days.length < 7 ? days : undefined;
    const emoji = p.emoji || "✨";
    setHabits((prev) => [
      {
        id: uid(),
        title: p.title,
        emoji,
        createdAt: Date.now(),
        log: [],
        days: normalized,
        bucket: normalizeBucket(p.bucket),
      },
      ...prev,
    ]);
    appendHistory({
      kind: "habit_created",
      title: p.title,
      meta: { emoji, days: normalized },
    });
    return `New habit: ${emoji} ${p.title}${normalized ? ` · ${daysLabel(normalized)}` : ""}`;
  }

  function handleResult(res: SmartResult, originalText: string) {
    // Durable facts ("Sam is a potential client") are kept regardless of
    // the main intent — the server already queued them for the learnings
    // export (/api/digest).
    if (res.remember) {
      appendHistory({ kind: "learning", title: res.remember });
    }
    if (res.intent === "todo") {
      setAssistant(addTodoFromParsed(res));
      setInput("");
      setPending(null);
      celebrate();
    } else if (res.intent === "breakdown") {
      // The capture was a goal, not a task — show the proposed first moves
      // instead of silently adding a monolith to the board.
      setBreakdown({ mode: "goal", goal: res.goal, subtasks: res.subtasks ?? [], added: [] });
      setAssistant(res.message || "That's a goal, not a single task — here's where it starts.");
      setInput("");
      setPending(null);
    } else if (res.intent === "batch") {
      // A brain dump — everything Kaka found, one tap to add all.
      const items = (res.items ?? []).map((it: BatchItem) => ({
        title: it.title,
        urgent: it.urgent ?? false,
        important: it.important ?? true,
        dueAt: it.dueAt,
        alarmLeadMin: it.alarmLeadMin,
        recurrence: it.recurrence,
        bucket: it.bucket,
        kind: it.kind,
        emoji: it.emoji,
        days: it.days,
      }));
      setBreakdown({ mode: "batch", subtasks: items, added: [] });
      setAssistant(res.message || `Found ${items.length} items in that.`);
      setInput("");
      setPending(null);
    } else if (res.intent === "habit") {
      setAssistant(addHabitFromParsed(res));
      setInput("");
      setPending(null);
    } else if (res.intent === "complete") {
      const todo = todos.find(
        (t) => !t.done && t.title.toLowerCase().includes(res.match.toLowerCase()),
      );
      if (todo) {
        toggleTodo(todo.id);
        setAssistant(`Marked "${todo.title}" done.`);
      } else {
        const habit = habits.find((h) =>
          h.title.toLowerCase().includes(res.match.toLowerCase()),
        );
        if (habit && !habit.log.includes(today)) {
          toggleHabit(habit.id);
          setAssistant(`Checked in on ${habit.emoji} ${habit.title}.`);
        } else {
          setAssistant(`Couldn't find "${res.match}" to complete.`);
        }
      }
      setInput("");
      setPending(null);
    } else if (res.intent === "delete") {
      const todo = todos.find((t) =>
        t.title.toLowerCase().includes(res.match.toLowerCase()),
      );
      if (todo) {
        setTodos((prev) => prev.filter((t) => t.id !== todo.id));
        setAssistant(`Removed "${todo.title}".`);
      } else {
        setAssistant(`Couldn't find "${res.match}".`);
      }
      setInput("");
      setPending(null);
    } else if (res.intent === "log") {
      appendHistory({ kind: "logged", title: res.note, meta: { domain: res.domain } });
      setAssistant(`Logged — ${res.note}`);
      setInput("");
      setPending(null);
    } else if (res.intent === "learning") {
      appendHistory({ kind: "learning", title: res.learning, meta: { source: res.source } });
      setAssistant(`Learning saved: "${res.learning}"`);
      setInput("");
      setPending(null);
    } else if (res.intent === "advice") {
      setAssistant(res.reply);
      setInput("");
      setPending(null);
    } else if (res.intent === "floor_update") {
      appendHistory({ kind: "logged", title: "Fitness floor updated", meta: { floor: res.floor } });
      setAssistant(res.message || "Floor updated.");
      setInput("");
      setPending(null);
    } else if (res.intent === "clarify") {
      setPending({ original: pending?.original ?? originalText, question: res.question });
      setAssistant(res.question);
      setInput("");
    } else if (res.intent === "unknown") {
      setAssistant(res.message);
      setPending(null);
    }
  }

  function toggleTodo(id: string) {
    setTodos((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        const done = !t.done;
        if (done) {
          celebrate();
          appendHistory({
            kind: "todo_completed",
            title: t.title,
            meta: {
              recurrence: t.recurrence,
              bucket: t.bucket,
              dueAt: t.dueAt ? new Date(t.dueAt).toISOString() : undefined,
            },
          });
          // Recurring tasks roll forward instead of finishing.
          if (t.recurrence && t.dueAt) {
            const rolled = advanceRecurring(t);
            return { ...rolled, done: false, completedAt: undefined };
          }
        } else {
          appendHistory({ kind: "todo_uncompleted", title: t.title });
        }
        return { ...t, done, completedAt: done ? Date.now() : undefined };
      }),
    );
  }

  function deleteTodo(id: string) {
    const t = todos.find((x) => x.id === id);
    if (t) appendHistory({ kind: "todo_deleted", title: t.title });
    setTodos((prev) => prev.filter((t) => t.id !== id));
  }

  function setTodoDue(id: string, dueAt: number | undefined) {
    const t = todos.find((x) => x.id === id);
    if (t)
      appendHistory({
        kind: "todo_rescheduled",
        title: t.title,
        meta: { dueAt: dueAt ? new Date(dueAt).toISOString() : null },
      });
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, dueAt } : t)));
  }

  function setTodoSurface(id: string, surfaceAt: number | undefined) {
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, surfaceAt } : t)));
  }

  function setTodoAlarm(id: string, alarmLeadMin: number | undefined) {
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, alarmLeadMin } : t)));
  }

  /** One-tap rescheduling: tomorrow 9am, next Monday 9am, or "later" —
   *  which strips the date entirely and drops the task into the Later box. */
  function postponeTodo(id: string, mode: "tomorrow" | "nextweek" | "later") {
    const t = todos.find((x) => x.id === id);
    if (!t) return;
    if (mode === "later") {
      setTodos((prev) =>
        prev.map((x) =>
          x.id === id
            ? {
                ...x,
                dueAt: undefined,
                surfaceAt: undefined,
                alarmLeadMin: undefined,
                urgent: false,
                important: false,
              }
            : x,
        ),
      );
      appendHistory({ kind: "todo_rescheduled", title: t.title, meta: { dueAt: null, moved: "later" } });
      return;
    }
    const d = new Date();
    if (mode === "tomorrow") d.setDate(d.getDate() + 1);
    else d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); // next Monday
    d.setHours(9, 0, 0, 0);
    setTodos((prev) => prev.map((x) => (x.id === id ? { ...x, dueAt: d.getTime() } : x)));
    appendHistory({
      kind: "todo_rescheduled",
      title: t.title,
      meta: { dueAt: d.toISOString(), moved: mode },
    });
  }

  function renameTodo(id: string, title: string) {
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)));
  }

  function setTodoQuadrant(id: string, q: Quadrant) {
    const { urgent, important } = QUADRANT_FLAGS[q];
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, urgent, important } : t)));
  }

  function renameHabit(id: string, title: string) {
    setHabits((prev) => prev.map((h) => (h.id === id ? { ...h, title } : h)));
  }

  function toggleHabit(id: string) {
    setHabits((prev) =>
      prev.map((h) => {
        if (h.id !== id) return h;
        const has = h.log.includes(today);
        if (has) {
          appendHistory({ kind: "habit_uncheck", title: h.title, meta: { emoji: h.emoji, date: today } });
          return { ...h, log: h.log.filter((d) => d !== today) };
        }
        celebrate({ intensity: "big" });
        appendHistory({
          kind: "habit_checkin",
          title: h.title,
          meta: { emoji: h.emoji, date: today, bucket: h.bucket },
        });
        return { ...h, log: [...h.log, today] };
      }),
    );
  }

  function deleteHabit(id: string) {
    const h = habits.find((x) => x.id === id);
    if (h) appendHistory({ kind: "habit_deleted", title: h.title, meta: { emoji: h.emoji } });
    setHabits((prev) => prev.filter((h) => h.id !== id));
  }

  function setHabitDays(id: string, days: number[] | undefined) {
    // All seven (or none) selected means "daily" — store as absent.
    const normalized = days && days.length > 0 && days.length < 7 ? days : undefined;
    setHabits((prev) => prev.map((h) => (h.id === id ? { ...h, days: normalized } : h)));
  }

  function archiveStale(ids: string[]) {
    const stale = todos.filter((t) => ids.includes(t.id));
    for (const t of stale) {
      appendHistory({ kind: "todo_deleted", title: t.title, meta: { stale: true } });
    }
    setTodos((prev) => prev.filter((t) => !ids.includes(t.id)));
    setAssistant(`Archived ${stale.length} stale task${stale.length === 1 ? "" : "s"}.`);
  }

  function commitPlan(ids: string[]) {
    setFocus({ date: today, ids });
    localStorage.setItem("kaka.plan.v1", today);
    setPlanDone(true);
    if (ids.length > 0) {
      const titles = todos.filter((t) => ids.includes(t.id)).map((t) => t.title);
      appendHistory({
        kind: "day_planned",
        title: `Picked ${ids.length} focus task${ids.length === 1 ? "" : "s"}`,
        meta: { titles },
      });
      celebrate();
    }
  }

  function closeDay(rollIds: string[], journal?: string) {
    const focusTodos =
      focus.date === today ? todos.filter((t) => focus.ids.includes(t.id)) : [];
    const done = focusTodos.filter((t) => t.done).length;
    if (rollIds.length > 0) {
      const tomorrow9 = new Date();
      tomorrow9.setDate(tomorrow9.getDate() + 1);
      tomorrow9.setHours(9, 0, 0, 0);
      setTodos((prev) =>
        prev.map((t) => (rollIds.includes(t.id) ? { ...t, dueAt: tomorrow9.getTime() } : t)),
      );
    }
    const note = journal?.trim();
    if (note) appendHistory({ kind: "journal", title: note });
    appendHistory({
      kind: "day_review",
      title: `Closed the day — ${done}/${focusTodos.length} focus tasks done`,
      meta: { done, total: focusTodos.length, rolled: rollIds.length },
    });
    localStorage.setItem("kaka.shutdown.v1", today);
    setShutdownDone(true);
  }

  const now = Date.now();
  const openTodos = todos.filter((t) => !t.done);
  const upcoming = openTodos.filter((t) => {
    const s = effectiveSurfaceAt(t);
    return s !== undefined && s > now;
  });
  const active = openTodos.filter((t) => {
    const s = effectiveSurfaceAt(t);
    return s === undefined || s <= now;
  });
  const byQuadrant: Record<Quadrant, Todo[]> = {
    do: [],
    schedule: [],
    later: [],
  };
  active.forEach((t) => byQuadrant[quadrantOf(t)].push(t));
  (Object.keys(byQuadrant) as Quadrant[]).forEach((q) => {
    byQuadrant[q].sort((a, b) => {
      if (a.dueAt && b.dueAt) return a.dueAt - b.dueAt;
      if (a.dueAt) return -1;
      if (b.dueAt) return 1;
      return 0;
    });
  });
  const staleLaterIds = byQuadrant.later.filter((t) => isStale(t, now)).map((t) => t.id);

  const doneToday = todos.filter(
    (t) => t.done && t.completedAt && todayISO(new Date(t.completedAt)) === today,
  ).length;

  // The daily pillars — a pillar lights up when something in it was
  // completed (or checked in) today.
  const bucketDone = Object.fromEntries(BUCKETS.map((b) => [b, false])) as Record<
    Bucket,
    boolean
  >;
  for (const t of todos) {
    if (
      t.done &&
      t.completedAt &&
      todayISO(new Date(t.completedAt)) === today &&
      t.bucket &&
      t.bucket !== "none"
    )
      bucketDone[t.bucket] = true;
  }
  for (const h of habits) {
    if (h.log.includes(today) && h.bucket && h.bucket !== "none") bucketDone[h.bucket] = true;
  }
  const missedBuckets = BUCKETS.filter((b) => !bucketDone[b]);

  // First run: nothing captured yet. The screen shows one invitation (the
  // composer) instead of a wall of empty sections and unearned stats.
  const isFirstRun = todos.length === 0 && habits.length === 0;

  // The headline: today's #1 — the first unfinished morning pick, else the
  // most pressing "Do now" task. Falls back to a quote only when there's
  // genuinely nothing to point at.
  const focusIds = focus.date === today ? focus.ids : [];
  const focusTodos = focusIds
    .map((id) => todos.find((t) => t.id === id))
    .filter((t): t is Todo => !!t);
  const oneThing =
    focusTodos.find((t) => !t.done) ?? byQuadrant.do[0] ?? byQuadrant.schedule[0] ?? null;

  const showPlanCard = synced && !planDone && focus.date !== today && active.length >= 2;
  const eveningHour = sessionSeed > 0 && new Date(sessionSeed).getHours() >= 20;
  // Evenings with picks OR any completed work get a close-out (and its
  // one-line journal — the intel Obsidian collects nightly).
  const showShutdownCard =
    synced &&
    eveningHour &&
    !shutdownDone &&
    ((focus.date === today && focusTodos.length > 0) || doneToday > 0);

  // Today strip: calendar events + today's timed tasks, in time order.
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const todayItems: { key: string; ts: number; title: string; kind: "event" | "todo"; allDay?: boolean }[] = [
    ...(calEvents ?? []).map((e) => ({
      key: `ev-${e.startMs}-${e.title}`,
      ts: e.startMs,
      title: e.title,
      kind: "event" as const,
      allDay: e.allDay,
    })),
    ...openTodos
      .filter((t) => t.dueAt && t.dueAt >= startOfToday.getTime() && t.dueAt <= endOfToday.getTime())
      .map((t) => ({
        key: `td-${t.id}`,
        ts: t.dueAt!,
        title: t.title,
        kind: "todo" as const,
        allDay: false,
      })),
  ].sort((a, b) => (a.allDay ? -1 : b.allDay ? 1 : a.ts - b.ts));

  return (
    <div className="mx-auto min-h-screen max-w-6xl px-5 py-4 max-md:py-3 md:py-12">
      {/* Header */}
      <header className="mb-8 flex items-center justify-between max-md:mb-3">
        <div className="flex items-center gap-3">
          <motion.span
            initial={{ rotate: -8, scale: 0.8 }}
            animate={{ rotate: 0, scale: 1 }}
            transition={{ type: "spring", stiffness: 260, damping: 14 }}
            aria-hidden
            className="text-4xl leading-none"
          >
            🐤
          </motion.span>
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight">Kaka</h1>
            <p className="text-xs text-muted-foreground">
              {new Date().toLocaleDateString("en-US", {
                weekday: "long",
                month: "short",
                day: "numeric",
              })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {doneToday > 0 && <Stat label="Done" value={String(doneToday)} />}
          <motion.button
            whileTap={{ scale: 0.85, rotate: -15 }}
            onClick={toggleDarkMode}
            aria-label={darkMode ? "Switch to light mode" : "Switch to dark mode"}
            className="grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            {darkMode ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </motion.button>
          <SettingsPopover
            showHistory={showHistory}
            onToggleHistory={setShowHistory}
            onSettingsSaved={() => {
              const start = new Date();
              start.setHours(0, 0, 0, 0);
              fetchEvents({
                data: { startMs: start.getTime(), endMs: start.getTime() + 86400000 },
              })
                .then(setCalEvents)
                .catch(() => {});
            }}
          />
        </div>
      </header>

      {/* Today's one thing — the single task that matters most right now.
          Falls back to the rotating quote only when there's nothing to do. */}
      <div className="mb-8 flex flex-wrap items-baseline gap-x-2 gap-y-1 max-md:mb-3">
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
        >
          {oneThing ? (
            <>
              <p className="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                <Target className="size-3 text-accent" strokeWidth={2.5} />
                {focusTodos.some((t) => !t.done) ? "Your pick for today" : "Today's one thing"}
              </p>
              <p className="font-display text-3xl font-semibold leading-tight tracking-tight max-md:text-lg max-md:leading-snug md:text-4xl">
                {oneThing.title}
              </p>
            </>
          ) : (
            <p className="font-display text-3xl font-semibold leading-tight tracking-tight max-md:text-lg max-md:leading-snug md:text-4xl">
              {headerQuote}
            </p>
          )}
        </motion.div>
        <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
          <span>signed in as</span>
          {editingName ? (
            <input
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onBlur={() => setEditingName(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "Escape") setEditingName(false);
              }}
              className="w-24 rounded-md border border-accent bg-card px-1.5 py-0.5 text-xs text-foreground outline-none"
            />
          ) : (
            <button
              onClick={() => setEditingName(true)}
              className="group inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-foreground hover:bg-surface-2"
              title="Click to edit"
            >
              {username || "Set name"}
              <Pencil className="size-3 opacity-0 transition-opacity group-hover:opacity-60" />
            </button>
          )}
        </span>
      </div>

      {/* The daily pillars — the rule: every day touches all of them.
          Hidden on first run: five gray "not yet" chips before the first
          capture read as reproach, not guidance. */}
      {!isFirstRun && (
      <div className="mb-6 flex flex-wrap items-center gap-2 max-md:mb-3">
        {BUCKETS.map((b) => {
          const done = bucketDone[b];
          const m = BUCKET_META[b];
          return (
            <span
              key={b}
              title={`${m.label} — ${done ? "done today" : "not yet today"}`}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                done
                  ? "border-neon/60 bg-neon/15 text-foreground"
                  : "border-border bg-card text-muted-foreground/70"
              }`}
            >
              <span aria-hidden>{m.emoji}</span>
              <span className="max-md:hidden">{m.label}</span>
              {done && <Check className="size-3" strokeWidth={3} />}
            </span>
          );
        })}
      </div>
      )}

      {/* Weekly review — one card, Mondays, until dismissed */}
      <AnimatePresence>
        {review && !reviewDismissed && (
          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, height: 0, marginBottom: 0 }}
            className="mb-6 max-md:mb-3"
          >
            <div className="rounded-3xl border border-accent/30 bg-accent/5 p-5 max-md:p-4">
              <div className="mb-2 flex items-center justify-between">
                <p className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                  <Sparkles className="size-3 text-accent" />
                  Your week in review
                </p>
                <button
                  onClick={() => {
                    localStorage.setItem("kaka.review.v1", review.weekOf);
                    setReviewDismissed(true);
                  }}
                  className="rounded-full px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-surface-2 hover:text-foreground"
                >
                  Dismiss
                </button>
              </div>
              <p className="text-sm leading-relaxed">{review.text}</p>
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      {/* Morning ritual: pick up to 3 tasks that define the day */}
      <AnimatePresence>
        {showPlanCard && (
          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, height: 0, marginBottom: 0 }}
            className="mb-6 max-md:mb-3"
          >
            <PlanCard todos={active} onCommit={commitPlan} onSkip={() => commitPlan([])} />
          </motion.section>
        )}
      </AnimatePresence>

      {/* Evening shutdown: close the day, roll what's left */}
      <AnimatePresence>
        {showShutdownCard && (
          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, height: 0, marginBottom: 0 }}
            className="mb-6 max-md:mb-3"
          >
            <ShutdownCard
              focusTodos={focus.date === today ? focusTodos : []}
              doneToday={doneToday}
              missedBuckets={missedBuckets}
              onClose={closeDay}
            />
          </motion.section>
        )}
      </AnimatePresence>

      {/* Smart composer */}
      <section className="mb-10 max-md:mb-3">
        <div className="rounded-3xl border border-border bg-card p-5 shadow-sm max-md:p-3.5">
          <div className="mb-3 flex items-center gap-2 max-md:hidden">
            <Sparkles className="size-4 text-accent" />
            <p className="text-xs font-medium text-muted-foreground">
              {pending ? "Kaka needs one detail" : "Ask Kaka anything"}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
                if (e.key === "Escape") {
                  setPending(null);
                  setAssistant(null);
                  setBreakdown(null);
                  setInput("");
                }
              }}
              placeholder={pending ? pending.question : "Ask Kaka anything…"}
              className="flex-1 bg-transparent text-lg outline-none placeholder:text-muted-foreground/60"
            />
            {speechSupported && (
              <button
                onClick={listening ? stopVoice : startVoice}
                disabled={busy}
                aria-label={listening ? "Stop voice" : "Voice input"}
                className={`grid size-11 place-items-center rounded-full border transition-colors ${
                  listening
                    ? "border-destructive bg-destructive/10 text-destructive animate-pulse"
                    : "border-border bg-surface text-muted-foreground hover:text-foreground hover:bg-surface-2"
                }`}
              >
                {listening ? <MicOff className="size-4" /> : <Mic className="size-4" />}
              </button>
            )}
            <motion.button
              whileTap={{ scale: 0.92 }}
              whileHover={{ scale: 1.04 }}
              onClick={() => submit()}
              disabled={busy || !input.trim()}
              className="grid size-11 place-items-center rounded-full bg-accent text-accent-foreground shadow-sm disabled:opacity-40"
              aria-label="Send"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            </motion.button>
          </div>

          {!pending && suggestions.length > 0 && (
            <div className="mt-3 flex gap-2 max-md:flex-nowrap max-md:overflow-x-auto max-md:pb-0.5 md:flex-wrap">
              {suggestions.slice(0, 5).map((s) => (
                <button
                  key={s}
                  onClick={() => submit(s)}
                  disabled={busy}
                  className="shrink-0 rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-surface-2 disabled:opacity-40"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          <AnimatePresence>
            {(assistant || error || filing) && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="mt-3 overflow-hidden"
              >
                {filing && !assistant && !error ? (
                  <div className="flex items-center gap-2 rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-muted-foreground">
                    <Loader2 className="size-3.5 shrink-0 animate-spin" />
                    <span className="truncate">Filing “{filing}”…</span>
                  </div>
                ) : (
                  <div
                    className={`rounded-2xl border px-4 py-3 text-sm ${
                      error
                        ? "border-destructive/40 bg-destructive/10 text-destructive"
                        : "border-border bg-surface text-foreground"
                    }`}
                  >
                    {error ?? assistant}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Goal breakdown: the capture was a project, not a task — offer
              its first moves instead of adding a monolith. */}
          <AnimatePresence>
            {breakdown && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="mt-3 overflow-hidden"
              >
                <div className="rounded-2xl border border-accent/30 bg-accent/5 p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <p className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                      <Target className="size-3 text-accent" strokeWidth={2.5} />
                      {breakdown.mode === "goal" ? "Goal → first moves" : "From your dump"}
                    </p>
                    <button
                      onClick={() => setBreakdown(null)}
                      className="rounded-full px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-surface-2 hover:text-foreground"
                    >
                      Dismiss
                    </button>
                  </div>
                  {breakdown.goal && <p className="mb-2.5 text-sm font-medium">{breakdown.goal}</p>}
                  <ul className="space-y-1.5">
                    {breakdown.subtasks.map((s, i) => {
                      const added = breakdown.added.includes(i);
                      const isHabit = s.kind === "habit";
                      const dueTs = s.dueAt ? new Date(s.dueAt).getTime() : undefined;
                      return (
                        <li
                          key={i}
                          className={`flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 ${added ? "opacity-60" : ""}`}
                        >
                          {isHabit && <span className="shrink-0 text-sm">{s.emoji ?? "✨"}</span>}
                          <span className="min-w-0 flex-1 truncate text-sm">{s.title}</span>
                          {isHabit && (
                            <span className="shrink-0 rounded-full bg-surface-2 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
                              habit
                            </span>
                          )}
                          {dueTs && Number.isFinite(dueTs) && (
                            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                              {formatDue(dueTs).label}
                            </span>
                          )}
                          <button
                            disabled={added}
                            onClick={() => {
                              if (isHabit) addHabitFromParsed(s);
                              else addTodoFromParsed(s);
                              setBreakdown((b) => (b ? { ...b, added: [...b.added, i] } : b));
                            }}
                            aria-label={added ? "Added" : `Add "${s.title}"`}
                            className={`grid size-6 shrink-0 place-items-center rounded-full border transition-colors ${
                              added
                                ? "border-neon/60 bg-neon/15"
                                : "border-border text-muted-foreground hover:border-accent hover:text-accent"
                            }`}
                          >
                            {added ? (
                              <Check className="size-3" strokeWidth={3} />
                            ) : (
                              <Plus className="size-3" strokeWidth={2.5} />
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      onClick={() => {
                        const remaining = breakdown.subtasks
                          .map((s, i) => ({ s, i }))
                          .filter(({ i }) => !breakdown.added.includes(i));
                        remaining.forEach(({ s }) => {
                          if (s.kind === "habit") addHabitFromParsed(s);
                          else addTodoFromParsed(s);
                        });
                        setAssistant(
                          breakdown.mode === "goal"
                            ? `Added ${remaining.length} step${remaining.length === 1 ? "" : "s"} toward "${breakdown.goal}".`
                            : `Added ${remaining.length} item${remaining.length === 1 ? "" : "s"} from your dump.`,
                        );
                        setBreakdown(null);
                        celebrate();
                      }}
                      className="rounded-full bg-accent px-4 py-1.5 text-xs font-medium text-accent-foreground shadow-sm"
                    >
                      Add all
                    </button>
                    {breakdown.mode === "goal" && breakdown.goal && (
                      <button
                        onClick={() => {
                          setAssistant(
                            addTodoFromParsed({
                              title: breakdown.goal!,
                              urgent: false,
                              important: true,
                              bucket: breakdown.subtasks[0]?.bucket,
                            }),
                          );
                          setBreakdown(null);
                        }}
                        className="rounded-full px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                      >
                        Add as one task anyway
                      </button>
                    )}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </section>

      {/* Today, in time order — calendar events + timed tasks */}
      {todayItems.length > 0 && (
        <section className="mb-10 max-md:mb-3">
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            <span className="flex shrink-0 items-center gap-1 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
              <Clock className="size-3" />
              Today
            </span>
            {todayItems.map((item) => {
              const past = !item.allDay && item.ts < now;
              return (
                <span
                  key={item.key}
                  className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${
                    item.kind === "event"
                      ? "border-sky/30 bg-sky/10"
                      : "border-border bg-card"
                  } ${past ? "opacity-45" : ""}`}
                >
                  {!item.allDay && (
                    <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                      {new Date(item.ts).toLocaleTimeString("en-US", {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </span>
                  )}
                  <span className="max-w-48 truncate">{item.title}</span>
                </span>
              );
            })}
          </div>
        </section>
      )}

      {/* First run: one welcome card carries the whole pitch — everything
          else (habits, matrix, history) appears once something exists. */}
      {isFirstRun && (
        <section className="mb-10 max-md:mb-4">
          <div className="rounded-3xl border border-accent/25 bg-accent/5 p-6 text-center max-md:p-5">
            <p className="font-display text-xl font-semibold tracking-tight">
              Your whole day, in one sentence.
            </p>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              Type it or say it — Kaka schedules it, reminds you, and files it
              under the right part of your life. Try one of the examples above,
              or dump everything on your mind in one go.
            </p>
          </div>
        </section>
      )}

      {/* Habits — compact horizontal streak strip on mobile, full cards on desktop */}
      {!isFirstRun && (
      <section className="mb-12 max-md:mb-3">
        <div className="mb-4 flex items-baseline justify-between max-md:mb-1.5">
          <h2 className="font-display text-3xl font-semibold tracking-tight max-md:text-base">
            Habits
          </h2>
          <p className="text-xs text-muted-foreground tabular-nums max-md:text-[10px]">
            {habits.filter((h) => habitScheduledOn(h) && h.log.includes(today)).length}/
            {habits.filter((h) => habitScheduledOn(h)).length} today
          </p>
        </div>
        {habits.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-border bg-card p-10 text-center max-md:p-5">
            <Flame className="mx-auto size-7 text-muted-foreground/40" />
            <p className="mt-2 text-sm text-muted-foreground">
              Try: "Read 20 minutes every day" — Kaka will set it up.
            </p>
          </div>
        ) : (
          <>
            <div className="flex gap-3 overflow-x-auto pb-1 md:hidden">
              {habits.map((h) => (
                <HabitChip
                  key={h.id}
                  habit={h}
                  onToggle={() => toggleHabit(h.id)}
                  onDelete={() => deleteHabit(h.id)}
                  onRename={(title) => renameHabit(h.id, title)}
                />
              ))}
            </div>
            <ul className="hidden gap-3 sm:grid-cols-2 md:grid lg:grid-cols-3">
              {habits.map((h) => (
                <HabitTile
                  key={h.id}
                  habit={h}
                  onToggle={() => toggleHabit(h.id)}
                  onDelete={() => deleteHabit(h.id)}
                  onRename={(title) => renameHabit(h.id, title)}
                  onSetDays={(days) => setHabitDays(h.id, days)}
                />
              ))}
            </ul>
          </>
        )}
      </section>
      )}

      {/* Eisenhower matrix */}
      {!isFirstRun && (
      <section className="mb-10 max-md:mb-3">
        <div className="mb-4 flex items-baseline justify-between max-md:mb-1.5">
          <h2 className="font-display text-3xl font-semibold tracking-tight max-md:text-base">
            To-dos
          </h2>
          <p className="text-xs text-muted-foreground tabular-nums max-md:text-[10px]">
            {active.length} active · {upcoming.length} upcoming · {doneToday} done
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {QUADRANT_ORDER.map((q) => (
            <QuadrantCard
              key={q}
              q={q}
              todos={byQuadrant[q]}
              staleIds={q === "later" ? staleLaterIds : []}
              onArchiveStale={archiveStale}
              onToggle={toggleTodo}
              onDelete={deleteTodo}
              onSetDue={setTodoDue}
              onSetAlarm={setTodoAlarm}
              onPostpone={postponeTodo}
              onRename={renameTodo}
              onMove={setTodoQuadrant}
              quadrantRefs={quadrantRefs}
            />
          ))}
        </div>

        {upcoming.length > 0 && (
          <div className="mt-4">
            <UpcomingSection
              todos={upcoming}
              onSurfaceNow={(id) => setTodoSurface(id, undefined)}
              onDelete={deleteTodo}
            />
          </div>
        )}
      </section>
      )}

      {!isFirstRun && showHistory && <HistorySection history={history} username={username} />}

      <footer className="border-t border-border pt-6 text-xs text-muted-foreground">
        <AnimatePresence mode="wait">
          <motion.div
            key={footerQuote.text}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5 }}
            className="flex flex-wrap items-baseline gap-2"
          >
            <span className="italic text-foreground/80">"{footerQuote.text}"</span>
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              — {footerQuote.by}
            </span>
          </motion.div>
        </AnimatePresence>
      </footer>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="hidden text-right sm:block">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

// Morning ritual: one card, once a day — pick up to 3 tasks that define the
// day. The first pick becomes the headline.
function PlanCard({
  todos,
  onCommit,
  onSkip,
}: {
  todos: Todo[];
  onCommit: (ids: string[]) => void;
  onSkip: () => void;
}) {
  const candidates = [...todos]
    .sort((a, b) => QUADRANT_ORDER.indexOf(quadrantOf(a)) - QUADRANT_ORDER.indexOf(quadrantOf(b)))
    .slice(0, 8);
  // Kaka pre-picks the three that matter most (due dates, importance, age,
  // and the keystone-pillar-every-day rule) — one tap accepts, taps adjust.
  const [selected, setSelected] = useState<string[]>(() => suggestPicks(candidates));

  function toggle(id: string) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : prev.length < 3 ? [...prev, id] : prev,
    );
  }

  return (
    <div className="rounded-3xl border border-accent/30 bg-card p-5 shadow-sm max-md:p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <p className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
          <Target className="size-3 text-accent" strokeWidth={2.5} />
          Plan your day — Kaka's picks, tap to adjust
        </p>
        <span className="text-[11px] tabular-nums text-muted-foreground">{selected.length}/3</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {candidates.map((t) => {
          const on = selected.includes(t.id);
          const order = on ? selected.indexOf(t.id) + 1 : null;
          return (
            <button
              key={t.id}
              onClick={() => toggle(t.id)}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors ${
                on
                  ? "border-accent bg-accent text-accent-foreground"
                  : "border-border bg-surface text-foreground hover:bg-surface-2"
              }`}
            >
              {order && <span className="font-mono text-[10px] font-semibold">{order}</span>}
              <span className="max-w-56 truncate">{t.title}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-4 flex items-center gap-2">
        <button
          onClick={() => onCommit(selected)}
          disabled={selected.length === 0}
          className="rounded-full bg-accent px-4 py-1.5 text-xs font-medium text-accent-foreground shadow-sm disabled:opacity-40"
        >
          Set my day
        </button>
        <button
          onClick={onSkip}
          className="rounded-full px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          Skip today
        </button>
      </div>
    </div>
  );
}

// Evening shutdown: after 8pm, close out the picks — roll what's left to
// tomorrow morning in one tap.
function ShutdownCard({
  focusTodos,
  doneToday,
  missedBuckets,
  onClose,
}: {
  focusTodos: Todo[];
  doneToday: number;
  missedBuckets: Bucket[];
  onClose: (rollIds: string[], journal?: string) => void;
}) {
  const done = focusTodos.filter((t) => t.done);
  const unfinished = focusTodos.filter((t) => !t.done);
  const [journal, setJournal] = useState("");
  return (
    <div className="rounded-3xl border border-border bg-card p-5 shadow-sm max-md:p-4">
      <p className="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
        <Moon className="size-3" />
        Close the day
      </p>
      <p className="text-sm">
        {focusTodos.length > 0 ? (
          <>
            {done.length} of {focusTodos.length} picks done
            {done.length === focusTodos.length ? " — clean sweep. 🎉" : "."}
            {unfinished.length > 0 && (
              <span className="text-muted-foreground">
                {" "}
                Left: {unfinished.map((t) => t.title).join(", ")}
              </span>
            )}
          </>
        ) : (
          <>
            {doneToday} task{doneToday === 1 ? "" : "s"} done today.
          </>
        )}
      </p>
      {missedBuckets.length > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          Pillars untouched today:{" "}
          {missedBuckets.map((b) => `${BUCKET_META[b].emoji} ${BUCKET_META[b].label}`).join(" · ")}
        </p>
      )}
      <input
        value={journal}
        onChange={(e) => setJournal(e.target.value)}
        placeholder="One line about today? (optional)"
        className="mt-3 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm outline-none placeholder:text-muted-foreground/60 focus:border-accent"
      />
      <div className="mt-3 flex items-center gap-2">
        {unfinished.length > 0 && (
          <button
            onClick={() => onClose(unfinished.map((t) => t.id), journal)}
            className="rounded-full bg-accent px-4 py-1.5 text-xs font-medium text-accent-foreground shadow-sm"
          >
            Roll to tomorrow 9am
          </button>
        )}
        <button
          onClick={() => onClose([], journal)}
          className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          {unfinished.length > 0 ? "Leave as is" : "Close day"}
        </button>
      </div>
    </div>
  );
}

// Settings: reminders for this device + the Google Calendar secret address.
function SettingsPopover({
  onSettingsSaved,
  showHistory,
  onToggleHistory,
}: {
  onSettingsSaved: () => void;
  showHistory: boolean;
  onToggleHistory: (v: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [icsUrl, setIcsUrl] = useState("");
  const [floor, setFloor] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fetchSettings = useServerFn(getSettings);
  const putSettings = useServerFn(saveSettings);
  const fetchFloor = useServerFn(getFloor);
  const putFloor = useServerFn(saveFloor);
  const saveSub = useServerFn(savePushSub);
  const testPush = useServerFn(sendTestPush);

  useEffect(() => {
    if (!open || loaded) return;
    Promise.all([fetchSettings(), fetchFloor()])
      .then(([s, f]) => {
        setIcsUrl(s.icsUrl ?? "");
        setFloor(f ?? "");
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loaded]);

  async function saveFloorText() {
    setBusy(true);
    setStatus(null);
    try {
      await putFloor({ data: { floor } });
      setStatus("Floor saved.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  }

  async function enableReminders() {
    setBusy(true);
    setStatus(null);
    try {
      const sub = await subscribeToPush();
      await saveSub({ data: { ...sub, label: navigator.userAgent.slice(0, 60) } });
      await testPush({});
      setStatus("Reminders on — a test notification is on its way.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Couldn't enable reminders.");
    } finally {
      setBusy(false);
    }
  }

  async function saveCalendar() {
    setBusy(true);
    setStatus(null);
    try {
      await putSettings({ data: { icsUrl: icsUrl.trim() } });
      setStatus(icsUrl.trim() ? "Calendar connected." : "Calendar removed.");
      onSettingsSaved();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <motion.button
        whileTap={{ scale: 0.85 }}
        onClick={() => setOpen((v) => !v)}
        aria-label="Settings"
        className="grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
      >
        <SettingsIcon className="size-4" />
      </motion.button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-2 w-80 rounded-2xl border border-border bg-card p-4 shadow-lg max-md:w-72">
            <div className="mb-4">
              <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold">
                <Bell className="size-3.5" /> Reminders
              </p>
              <p className="mb-2 text-[11px] leading-snug text-muted-foreground">
                Get a notification on this device when a task's reminder time hits.
              </p>
              <button
                onClick={enableReminders}
                disabled={busy}
                className="rounded-full bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground shadow-sm disabled:opacity-40"
              >
                {busy ? "Working…" : "Enable on this device"}
              </button>
            </div>
            <div>
              <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold">
                <Calendar className="size-3.5" /> Google Calendar
              </p>
              <p className="mb-2 text-[11px] leading-snug text-muted-foreground">
                Paste your calendar's <b>Secret address in iCal format</b> (Google Calendar →
                Settings → your calendar → Integrate calendar). Events show in the Today strip.
              </p>
              <input
                value={icsUrl}
                onChange={(e) => setIcsUrl(e.target.value)}
                placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
                className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-[11px] outline-none focus:border-accent"
              />
              <button
                onClick={saveCalendar}
                disabled={busy}
                className="mt-2 rounded-full border border-border px-3 py-1.5 text-xs text-foreground hover:bg-surface-2 disabled:opacity-40"
              >
                Save
              </button>
            </div>
            <div className="mt-4">
              <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold">
                <Flame className="size-3.5" /> Fitness floor
              </p>
              <p className="mb-2 text-[11px] leading-snug text-muted-foreground">
                Your minimum acceptable week — the AI and weekly review judge against this.
                You can also change it by just telling Kaka ("update my floor: …").
              </p>
              <textarea
                value={floor}
                onChange={(e) => setFloor(e.target.value)}
                rows={5}
                placeholder="e.g. Terrace 15 daily; 5 of 7 days keeps the week…"
                className="w-full resize-y rounded-md border border-border bg-surface px-2 py-1.5 text-[11px] leading-snug outline-none focus:border-accent"
              />
              <button
                onClick={saveFloorText}
                disabled={busy}
                className="mt-1 rounded-full border border-border px-3 py-1.5 text-xs text-foreground hover:bg-surface-2 disabled:opacity-40"
              >
                Save
              </button>
            </div>
            <div className="mt-4 border-t border-border pt-3">
              <label className="flex cursor-pointer items-center justify-between gap-3">
                <span className="text-xs font-medium text-foreground">Show history on main screen</span>
                <input
                  type="checkbox"
                  checked={showHistory}
                  onChange={(e) => onToggleHistory(e.target.checked)}
                  className="size-4 accent-accent"
                />
              </label>
              <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                Every capture, completion and check-in, with Markdown/JSON export.
              </p>
            </div>
            {status && <p className="mt-3 text-[11px] leading-snug text-accent">{status}</p>}
          </div>
        </>
      )}
    </div>
  );
}

function HistorySection({
  history,
  username,
}: {
  history: HistoryEvent[];
  username: string;
}) {
  const [filter, setFilter] = useState<(typeof KIND_CATEGORIES)[number]["id"]>("all");
  const cat = KIND_CATEGORIES.find((c) => c.id === filter)!;
  const filtered = cat.kinds
    ? history.filter((e) => (cat.kinds as HistoryKind[]).includes(e.kind))
    : history;
  const visible = filtered.slice(0, 50);

  return (
    <section className="mb-10">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <HistoryIcon className="size-5 self-center text-muted-foreground" />
          <h2 className="font-display text-3xl font-semibold tracking-tight">History</h2>
          <p className="text-xs text-muted-foreground tabular-nums">
            {history.length} events
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {KIND_CATEGORIES.map((c) => (
            <button
              key={c.id}
              onClick={() => setFilter(c.id)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                filter === c.id
                  ? "border-accent bg-accent text-accent-foreground"
                  : "border-border bg-card text-muted-foreground hover:text-foreground"
              }`}
            >
              {c.label}
            </button>
          ))}
          <button
            onClick={() => downloadHistory(history, username)}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            title="Download as Markdown (LLM-friendly)"
          >
            <Download className="size-3" />
            .md
          </button>
          <button
            onClick={() => downloadHistoryJSON(history, username)}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            title="Download as JSON"
          >
            <Download className="size-3" />
            .json
          </button>
          {history.length > 0 && (
            <button
              onClick={() => {
                if (confirm("Clear all history? This cannot be undone.")) clearHistory();
              }}
              className="inline-flex items-center gap-1 rounded-full border border-transparent px-2 py-1 text-[11px] text-muted-foreground hover:text-destructive"
            >
              Clear
            </button>
          )}
        </div>
      </div>
      {visible.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-border bg-card p-10 text-center">
          <p className="text-sm text-muted-foreground">
            Nothing yet. Every capture, completion and check-in lands here.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-3xl border border-border bg-card">
          {visible.map((ev) => (
            <HistoryRow key={ev.id} ev={ev} />
          ))}
        </ul>
      )}
      {filtered.length > visible.length && (
        <p className="mt-3 text-center text-xs text-muted-foreground">
          Showing latest {visible.length} of {filtered.length}. Download for the full log.
        </p>
      )}
    </section>
  );
}

function HistoryRow({ ev }: { ev: HistoryEvent }) {
  const d = new Date(ev.ts);
  const time = d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const tone =
    ev.kind.includes("completed") || ev.kind === "habit_checkin"
      ? "bg-neon/20 text-foreground"
      : ev.kind.includes("deleted")
        ? "bg-destructive/10 text-destructive"
        : ev.kind === "captured"
          ? "bg-accent/15 text-accent"
          : ev.kind.includes("habit")
            ? "bg-amber/20 text-foreground"
            : "bg-sky/15 text-sky";
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${tone}`}>
        {kindLabel(ev.kind)}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm">{ev.title}</span>
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
        {time}
      </span>
    </li>
  );
}

function UpcomingSection({
  todos,
  onSurfaceNow,
  onDelete,
}: {
  todos: Todo[];
  onSurfaceNow: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const sorted = [...todos].sort((a, b) => (a.surfaceAt ?? 0) - (b.surfaceAt ?? 0));
  return (
    <section className="mb-10">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="font-display text-2xl font-semibold tracking-tight text-muted-foreground">
          Upcoming
        </h2>
        <p className="text-xs text-muted-foreground">
          Surfaces into the matrix automatically
        </p>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2">
        {sorted.map((t) => {
          const surface = t.surfaceAt ? formatDue(t.surfaceAt) : null;
          const due = t.dueAt ? formatDue(t.dueAt) : null;
          return (
            <li
              key={t.id}
              className="group flex items-center gap-3 rounded-2xl border border-dashed border-border bg-card/60 px-3 py-2.5"
            >
              <Hourglass className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 truncate text-sm">
                  {t.title}
                  {t.recurrence && (
                    <Repeat className="size-3 text-muted-foreground" />
                  )}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {due && <>Due {due.label}</>}
                  {surface && (
                    <> · surfaces {surface.label}</>
                  )}
                </p>
              </div>
              <button
                onClick={() => onSurfaceNow(t.id)}
                className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:border-accent hover:text-accent"
              >
                Surface now
              </button>
              <button
                onClick={() => onDelete(t.id)}
                aria-label="Delete"
                className="rounded-full p-1 text-muted-foreground/40 hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function QuadrantCard({
  q,
  todos,
  staleIds,
  onArchiveStale,
  onToggle,
  onDelete,
  onSetDue,
  onSetAlarm,
  onPostpone,
  onRename,
  onMove,
  quadrantRefs,
}: {
  q: Quadrant;
  todos: Todo[];
  staleIds: string[];
  onArchiveStale: (ids: string[]) => void;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onSetDue: (id: string, dueAt: number | undefined) => void;
  onSetAlarm: (id: string, alarmLeadMin: number | undefined) => void;
  onPostpone: (id: string, mode: "tomorrow" | "nextweek" | "later") => void;
  onRename: (id: string, title: string) => void;
  onMove: (id: string, q: Quadrant) => void;
  quadrantRefs: React.RefObject<Partial<Record<Quadrant, HTMLDivElement>>>;
}) {
  const meta = QUADRANT_META[q];
  const Icon = meta.icon;
  return (
    <div
      ref={(el) => {
        if (el) quadrantRefs.current[q] = el;
      }}
      data-quadrant={q}
      className={`rounded-3xl border p-5 ${meta.tint} ${q === "later" ? "md:col-span-2" : ""}`}
    >
      <div className="mb-4 flex items-baseline justify-between">
        <div className="flex items-center gap-2.5">
          <span className={`grid size-8 place-items-center rounded-xl ${meta.chip}`}>
            <Icon className="size-4" strokeWidth={2.25} />
          </span>
          <div>
            <h3 className="text-sm font-semibold tracking-tight">{meta.label}</h3>
            <p className="text-[11px] text-muted-foreground">{meta.sub}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {staleIds.length > 0 && (
            <button
              onClick={() => onArchiveStale(staleIds)}
              title="Delete tasks that have sat here untouched for 3+ weeks"
              className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:border-destructive/40 hover:text-destructive"
            >
              <Trash2 className="size-2.5" />
              Clear {staleIds.length} stale
            </button>
          )}
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ${meta.chip}`}>
            {todos.length}
          </span>
        </div>
      </div>
      {todos.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground/60">Nothing here</p>
      ) : (
        <ul className="space-y-2">
          <AnimatePresence initial={false}>
            {todos.map((t) => (
              <TodoRow
                key={t.id}
                todo={t}
                stale={staleIds.includes(t.id)}
                currentQuadrant={q}
                onToggle={() => onToggle(t.id)}
                onDelete={() => onDelete(t.id)}
                onSetDue={(dueAt) => onSetDue(t.id, dueAt)}
                onSetAlarm={(min) => onSetAlarm(t.id, min)}
                onPostpone={(mode) => onPostpone(t.id, mode)}
                onRename={(title) => onRename(t.id, title)}
                onMove={(nextQ) => onMove(t.id, nextQ)}
                quadrantRefs={quadrantRefs}
              />
            ))}
          </AnimatePresence>
        </ul>
      )}
    </div>
  );
}

function TodoRow({
  todo,
  stale = false,
  currentQuadrant,
  onToggle,
  onDelete,
  onSetDue,
  onSetAlarm,
  onPostpone,
  onRename,
  onMove,
  quadrantRefs,
}: {
  todo: Todo;
  stale?: boolean;
  currentQuadrant: Quadrant;
  onToggle: () => void;
  onDelete: () => void;
  onSetDue: (dueAt: number | undefined) => void;
  onSetAlarm: (alarmLeadMin: number | undefined) => void;
  onPostpone: (mode: "tomorrow" | "nextweek" | "later") => void;
  onRename: (title: string) => void;
  onMove: (q: Quadrant) => void;
  quadrantRefs: React.RefObject<Partial<Record<Quadrant, HTMLDivElement>>>;
}) {
  const [editing, setEditing] = useState(false);
  const [editingAlarm, setEditingAlarm] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(todo.title);
  const [dragging, setDragging] = useState(false);
  const due = todo.dueAt ? formatDue(todo.dueAt) : null;
  // Reminders are on by default for dated tasks (10 min before); -1 = muted.
  const alarmLead = todo.dueAt ? (todo.alarmLeadMin ?? 10) : undefined;
  const alarmOn = alarmLead != null && alarmLead >= 0;
  const dragControls = useDragControls();

  function commitTitle() {
    const next = titleDraft.trim();
    if (next && next !== todo.title) onRename(next);
    else setTitleDraft(todo.title);
    setEditingTitle(false);
  }

  function handleDragEnd(event: any, info: { point: { x: number; y: number } }) {
    setDragging(false);
    // Prefer the raw pointer event's clientX/Y (unambiguously viewport-relative,
    // matching getBoundingClientRect()) over info.point, whose coordinate space
    // isn't consistently documented across framer-motion versions.
    const x = typeof event?.clientX === "number" ? event.clientX : info.point.x;
    const y = typeof event?.clientY === "number" ? event.clientY : info.point.y;
    for (const q of QUADRANT_ORDER) {
      if (q === currentQuadrant) continue;
      const el = quadrantRefs.current[q];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        onMove(q);
        return;
      }
    }
  }
  const toneClass =
    due?.tone === "overdue"
      ? "bg-destructive/10 text-destructive"
      : due?.tone === "today"
        ? "bg-rose/15 text-rose"
        : due?.tone === "soon"
          ? "bg-sky/15 text-sky"
          : "bg-surface-2 text-muted-foreground";

  return (
    <motion.li
      layout={!dragging}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: 40 }}
      transition={{ type: "spring", stiffness: 400, damping: 30 }}
      drag
      dragControls={dragControls}
      dragListener={false}
      dragSnapToOrigin
      dragElastic={0.15}
      dragMomentum={false}
      onDragStart={() => setDragging(true)}
      onDragEnd={handleDragEnd}
      whileDrag={{ scale: 1.05, zIndex: 50, boxShadow: "0 16px 40px rgba(0,0,0,0.18)" }}
      className={`group relative flex items-center gap-3 rounded-2xl border border-border bg-card px-3 py-2.5 shadow-[0_1px_0_rgba(0,0,0,0.03)] ${stale ? "opacity-55" : ""}`}
    >
      <motion.button
        whileTap={{ scale: 0.85 }}
        onClick={onToggle}
        aria-label="Complete"
        className="grid size-6 shrink-0 place-items-center rounded-full border-2 border-border transition-colors hover:border-accent"
      >
        {todo.done && <Check className="size-3.5 text-accent" strokeWidth={3} />}
      </motion.button>
      <div className="min-w-0 flex-1">
        {editingTitle ? (
          <input
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTitle();
              if (e.key === "Escape") {
                setTitleDraft(todo.title);
                setEditingTitle(false);
              }
            }}
            autoFocus
            className="w-full rounded-md border border-accent bg-surface px-1.5 py-0.5 text-sm outline-none"
          />
        ) : (
          <button
            onClick={() => {
              setTitleDraft(todo.title);
              setEditingTitle(true);
            }}
            className="flex w-full items-center gap-1.5 truncate text-left text-sm"
          >
            <span className="truncate">{todo.title}</span>
            {todo.recurrence && (
              <Repeat className="size-3 shrink-0 text-muted-foreground" />
            )}
          </button>
        )}
        {due && !editing && (
          <button
            onClick={() => setEditing(true)}
            className={`mt-1 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${toneClass}`}
          >
            <Clock className="size-2.5" strokeWidth={2.5} />
            {due.label}
            {alarmOn ? (
              <Bell className="size-2.5" strokeWidth={2.5} />
            ) : (
              <BellOff className="size-2.5 opacity-50" strokeWidth={2.5} />
            )}
          </button>
        )}
        {editing && (
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <input
              type="datetime-local"
              defaultValue={toLocalInputValue(todo.dueAt)}
              onChange={(e) => {
                const v = e.target.value;
                onSetDue(v ? new Date(v).getTime() : undefined);
              }}
              onBlur={() => setEditing(false)}
              autoFocus
              className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-[11px] outline-none focus:border-accent"
            />
            {/* onPointerDown, not onClick: these must win the race against the
                input's blur, which unmounts this row before a click lands. */}
            <button
              onPointerDown={(e) => {
                e.preventDefault();
                onPostpone("tomorrow");
                setEditing(false);
              }}
              className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:border-accent hover:text-accent"
            >
              Tomorrow 9am
            </button>
            <button
              onPointerDown={(e) => {
                e.preventDefault();
                onPostpone("nextweek");
                setEditing(false);
              }}
              className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:border-accent hover:text-accent"
            >
              Next week
            </button>
            <button
              onPointerDown={(e) => {
                e.preventDefault();
                onPostpone("later");
                setEditing(false);
              }}
              className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:border-destructive/50 hover:text-destructive"
            >
              No date → Later
            </button>
          </div>
        )}
      </div>
      {!due && !editing && (
        <button
          onClick={() => setEditing(true)}
          aria-label="Set due date"
          className="rounded-full p-1.5 text-muted-foreground/40 transition-all hover:text-accent"
        >
          <Calendar className="size-3.5" />
        </button>
      )}
      {due && (
        <div className="relative">
          <button
            onClick={() => setEditingAlarm((v) => !v)}
            aria-label="Set reminder"
            title={
              alarmOn
                ? `Reminds ${alarmLead === 0 ? "at time" : `${alarmLead}m before`}`
                : "Reminder off"
            }
            className={`rounded-full p-1.5 transition-all hover:text-accent ${
              alarmOn ? "text-accent" : "text-muted-foreground/40"
            }`}
          >
            {alarmOn ? <Bell className="size-3.5" /> : <BellOff className="size-3.5" />}
          </button>
          {editingAlarm && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setEditingAlarm(false)} />
              <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-2xl border border-border bg-card p-2.5 shadow-lg">
                <label className="block text-[10px] text-muted-foreground">
                  Remind me · on by default
                </label>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {(
                    [
                      { min: 0, label: "At time" },
                      { min: 10, label: "10m before" },
                      { min: 30, label: "30m before" },
                      { min: 60, label: "1h before" },
                    ] as const
                  ).map(({ min, label }) => (
                    <button
                      key={min}
                      onClick={() => {
                        onSetAlarm(min);
                        setEditingAlarm(false);
                      }}
                      className={`rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                        alarmLead === min
                          ? "border-accent bg-accent text-accent-foreground"
                          : "border-border text-muted-foreground hover:border-accent hover:text-accent"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {alarmOn && (
                  <button
                    onClick={() => {
                      onSetAlarm(-1);
                      setEditingAlarm(false);
                    }}
                    className="mt-1.5 text-[10px] text-muted-foreground hover:text-destructive"
                  >
                    Turn off reminder
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
      <button
        onPointerDown={(e) => dragControls.start(e)}
        onMouseDown={(e) => dragControls.start(e as unknown as React.PointerEvent)}
        aria-label="Drag to move to another quadrant"
        className="cursor-grab touch-none rounded-full p-1.5 text-muted-foreground/40 transition-all hover:text-accent active:cursor-grabbing"
        style={{ touchAction: "none" }}
      >
        <Move className="size-3.5" />
      </button>
      <button
        onClick={onDelete}
        aria-label="Delete"
        className="rounded-full p-1.5 text-muted-foreground/40 transition-all hover:text-destructive"
      >
        <Trash2 className="size-3.5" />
      </button>
    </motion.li>
  );
}

function HabitTile({
  habit,
  onToggle,
  onDelete,
  onRename,
  onSetDays,
}: {
  habit: Habit;
  onToggle: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
  onSetDays: (days: number[] | undefined) => void;
}) {
  const today = todayISO();
  const done = habit.log.includes(today);
  const restDay = !habitScheduledOn(habit);
  const streak = computeStreak(habit.log, habit.days);
  const days = lastNDays(14);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDays, setEditingDays] = useState(false);
  const [titleDraft, setTitleDraft] = useState(habit.title);

  function toggleDay(d: number) {
    const current = habit.days && habit.days.length > 0 ? habit.days : [0, 1, 2, 3, 4, 5, 6];
    const next = current.includes(d) ? current.filter((x) => x !== d) : [...current, d];
    if (next.length === 0) return; // a habit needs at least one day
    onSetDays(next);
  }

  function commitTitle() {
    const next = titleDraft.trim();
    if (next && next !== habit.title) onRename(next);
    else setTitleDraft(habit.title);
    setEditingTitle(false);
  }

  return (
    <motion.li
      layout
      className="group rounded-3xl border border-border bg-card p-4 shadow-sm"
    >
      <div className="flex items-center gap-3">
        <motion.button
          whileTap={{ scale: 0.88 }}
          whileHover={{ scale: 1.05 }}
          onClick={onToggle}
          className={`grid size-12 shrink-0 place-items-center rounded-2xl text-2xl transition-colors ${
            done ? "bg-neon/30 ring-2 ring-neon" : "bg-surface-2 hover:bg-surface-2/70"
          } ${restDay && !done ? "opacity-50" : ""}`}
        >
          <span>{habit.emoji}</span>
        </motion.button>
        <div className="min-w-0 flex-1">
          {editingTitle ? (
            <input
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitTitle();
                if (e.key === "Escape") {
                  setTitleDraft(habit.title);
                  setEditingTitle(false);
                }
              }}
              autoFocus
              className="w-full rounded-md border border-accent bg-surface px-1.5 py-0.5 text-sm outline-none"
            />
          ) : (
            <button
              onClick={() => {
                setTitleDraft(habit.title);
                setEditingTitle(true);
              }}
              className="block w-full truncate text-left text-sm font-medium"
            >
              {habit.title}
            </button>
          )}
          <div className="mt-0.5 flex items-center gap-1.5">
            <Flame
              className={`size-3 ${streak > 0 ? "text-amber" : "text-muted-foreground/50"}`}
            />
            <span className="text-[11px] text-muted-foreground tabular-nums">
              <span className={streak > 0 ? "font-semibold text-amber" : ""}>{streak}</span> day
              streak
            </span>
            <button
              onClick={() => setEditingDays((v) => !v)}
              className="rounded-full px-1.5 py-0.5 text-[10px] text-muted-foreground/70 hover:bg-surface-2 hover:text-foreground"
              title="Which days does this habit run?"
            >
              {restDay ? "Rest day · " : ""}
              {daysLabel(habit.days)}
            </button>
          </div>
        </div>
        <button
          onClick={onDelete}
          aria-label="Delete habit"
          className="rounded-full p-1.5 text-muted-foreground/40 hover:text-destructive"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
      {editingDays && (
        <div className="mt-2 flex items-center gap-1">
          {DAY_LETTERS.map((letter, d) => {
            const active = !habit.days || habit.days.length === 0 || habit.days.includes(d);
            return (
              <button
                key={d}
                onClick={() => toggleDay(d)}
                className={`grid size-6 place-items-center rounded-full text-[10px] font-semibold transition-colors ${
                  active
                    ? "bg-accent text-accent-foreground"
                    : "bg-surface-2 text-muted-foreground/60"
                }`}
                aria-label={`Toggle ${letter}`}
              >
                {letter}
              </button>
            );
          })}
        </div>
      )}
      <div className="mt-3 flex gap-1">
        {days.map((d) => {
          const scheduled = habitScheduledOn(habit, new Date(`${d}T12:00:00`));
          return (
            <div
              key={d}
              className={`h-1.5 flex-1 rounded-full ${
                habit.log.includes(d)
                  ? "bg-neon"
                  : scheduled
                    ? "bg-surface-2"
                    : "bg-surface-2/30"
              }`}
            />
          );
        })}
      </div>
    </motion.li>
  );
}

// Compact mobile habit view: a small streak badge per habit in a horizontal
// scroll row, instead of a full-width card each — keeps the whole Habits
// section short so it doesn't eat the screen.
function HabitChip({
  habit,
  onToggle,
  onDelete,
  onRename,
}: {
  habit: Habit;
  onToggle: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
}) {
  const today = todayISO();
  const done = habit.log.includes(today);
  const restDay = !habitScheduledOn(habit);
  const streak = computeStreak(habit.log, habit.days);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(habit.title);

  function commitTitle() {
    const next = titleDraft.trim();
    if (next && next !== habit.title) onRename(next);
    else setTitleDraft(habit.title);
    setEditingTitle(false);
  }

  return (
    <motion.div layout className="relative flex w-20 shrink-0 flex-col items-center gap-1 pt-2">
      <button
        onClick={onDelete}
        aria-label="Delete habit"
        className="absolute right-1 top-0 grid size-4 place-items-center rounded-full bg-card text-muted-foreground/60 ring-1 ring-border"
      >
        <span className="text-[10px] leading-none">×</span>
      </button>
      <motion.button
        whileTap={{ scale: 0.88 }}
        onClick={onToggle}
        className={`grid size-12 place-items-center rounded-2xl text-xl transition-colors ${
          done ? "bg-neon/30 ring-2 ring-neon" : "bg-card border border-border"
        } ${restDay && !done ? "opacity-50" : ""}`}
      >
        <span>{habit.emoji}</span>
      </motion.button>
      {editingTitle ? (
        <input
          value={titleDraft}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitTitle();
            if (e.key === "Escape") {
              setTitleDraft(habit.title);
              setEditingTitle(false);
            }
          }}
          autoFocus
          className="w-full rounded-md border border-accent bg-surface px-1 py-0.5 text-center text-[10px] outline-none"
        />
      ) : (
        <button
          onClick={() => {
            setTitleDraft(habit.title);
            setEditingTitle(true);
          }}
          className="line-clamp-2 max-w-20 text-center text-[10px] leading-tight text-muted-foreground"
        >
          {habit.title}
        </button>
      )}
      {streak > 0 && (
        <span className="flex items-center gap-0.5 text-[10px] font-semibold text-amber">
          <Flame className="size-2.5" />
          {streak}
        </span>
      )}
    </motion.div>
  );
}
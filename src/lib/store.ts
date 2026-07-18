import { useEffect, useState } from "react";

import { PILLARS } from "../config";

export type Priority = "low" | "med" | "high";

export type Recurrence = "yearly" | "monthly" | "weekly";

/** The user's daily pillars (defined in src/config.ts) — every day should
 *  touch all of them. Tasks and habits are classified silently by the AI;
 *  "none" marks pure chores (so they aren't re-classified on every load). */
export type Bucket = (typeof PILLARS)[number]["id"];

export const BUCKETS: Bucket[] = PILLARS.map((p) => p.id);

export const BUCKET_META: Record<Bucket, { label: string; emoji: string }> = Object.fromEntries(
  PILLARS.map((p) => [p.id, { label: p.label, emoji: p.emoji }]),
) as Record<Bucket, { label: string; emoji: string }>;

export type Todo = {
  id: string;
  title: string;
  done: boolean;
  priority: Priority;
  urgent: boolean;
  important: boolean;
  createdAt: number;
  completedAt?: number;
  dueAt?: number;
  /** When this task starts appearing in the priority matrix. If in the
   *  future, it lives in "Upcoming" until that time. */
  surfaceAt?: number;
  /** If set, completing rolls dueAt/surfaceAt forward instead of finishing. */
  recurrence?: Recurrence;
  /** Minutes before dueAt to fire a reminder. Only meaningful if dueAt is set —
   *  the actual alarm time is dueAt - alarmLeadMin minutes. Reminders are ON
   *  by default: absent = 10 min before; -1 = explicitly muted. */
  alarmLeadMin?: number;
  /** Which of the five daily pillars this serves; "none" = chore/errand. */
  bucket?: Bucket | "none";
};

export type Habit = {
  id: string;
  title: string;
  emoji: string;
  createdAt: number;
  /** ISO date strings yyyy-mm-dd of completion days */
  log: string[];
  /** Weekdays this habit is scheduled on (0=Sun..6=Sat). Absent/empty = every day. */
  days?: number[];
  /** Which of the five daily pillars this serves; "none" = chore/errand. */
  bucket?: Bucket | "none";
};

/** The tasks picked as today's focus in the morning ritual. Only valid while
 *  `date` is still today — a new day resets the ritual. */
export type Focus = {
  date: string;
  ids: string[];
};

export type Stats = {
  xp: number;
  level: number;
};

const KEYS = {
  todos: "cred.todos.v1",
  habits: "cred.habits.v1",
  stats: "cred.stats.v1",
  focus: "kaka.focus.v1",
} as const;

function load<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save<T>(key: string, value: T) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, JSON.stringify(value));
}

export function useLocal<T>(key: string, initial: T) {
  const [state, setState] = useState<T>(initial);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setState(load<T>(key, initial));
    setReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    if (ready) save(key, state);
  }, [key, state, ready]);
  return [state, setState, ready] as const;
}

export const STORAGE_KEYS = KEYS;

const LAST_MODIFIED_KEY = "kaka.lastmod.v1";

/** Timestamp of this device's last local edit — used to decide whether an
 *  incoming sync from another device is newer (and should win) or older
 *  (and should be ignored) on load. */
export function getLastModified(): number {
  if (typeof window === "undefined") return 0;
  return Number(window.localStorage.getItem(LAST_MODIFIED_KEY) ?? 0);
}

export function setLastModified(ts: number) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LAST_MODIFIED_KEY, String(ts));
}

export function todayISO(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function lastNDays(n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    out.push(todayISO(d));
  }
  return out;
}

/** Is this habit scheduled on the given date? No `days` means daily. */
export function habitScheduledOn(habit: Pick<Habit, "days">, d = new Date()): boolean {
  if (!habit.days || habit.days.length === 0) return true;
  return habit.days.includes(d.getDay());
}

export function computeStreak(log: string[], days?: number[]): number {
  const set = new Set(log);
  const scheduled = (d: Date) => !days || days.length === 0 || days.includes(d.getDay());
  let streak = 0;
  const d = new Date();
  // Today doesn't break the streak while it's still in progress: if today is
  // a scheduled day but not yet done, start counting from the previous day.
  if (scheduled(d) && !set.has(todayISO(d))) d.setDate(d.getDate() - 1);
  // Walk backwards; non-scheduled days are skipped, not counted and not
  // streak-breaking. Capped so a corrupt log can't loop forever.
  for (let i = 0; i < 3660; i++) {
    if (scheduled(d)) {
      if (!set.has(todayISO(d))) break;
      streak++;
    }
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

export const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"] as const;
export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** "Every day" or "Mon · Wed · Fri" */
export function daysLabel(days?: number[]): string {
  if (!days || days.length === 0 || days.length === 7) return "Every day";
  return [...days].sort((a, b) => a - b).map((d) => DAY_NAMES[d]).join(" · ");
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export const XP_TODO = 10;
export const XP_HABIT = 15;
export const XP_PER_LEVEL = 100;

export function levelFromXp(xp: number) {
  const level = Math.floor(xp / XP_PER_LEVEL) + 1;
  const into = xp % XP_PER_LEVEL;
  return { level, into, pct: (into / XP_PER_LEVEL) * 100 };
}
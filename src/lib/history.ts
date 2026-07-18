import { useEffect, useState } from "react";

export type HistoryKind =
  | "captured" // raw user input sent to Kaka
  | "todo_created"
  | "todo_completed"
  | "todo_uncompleted"
  | "todo_deleted"
  | "todo_rescheduled"
  | "habit_created"
  | "habit_checkin"
  | "habit_uncheck"
  | "habit_deleted"
  | "day_planned" // morning ritual: focus tasks picked
  | "day_review" // evening shutdown: day closed
  | "logged" // free-text life log (food, fitness, sleep, anything)
  | "learning" // pasted content distilled to an insight — filed to SecondBrain
  | "journal"; // optional one-liner from the evening shutdown out

export type HistoryEvent = {
  id: string;
  ts: number;
  kind: HistoryKind;
  title: string;
  meta?: Record<string, unknown>;
};

export const HISTORY_KEY = "kaka.history.v1";
const MAX_HISTORY = 2000;

export function appendHistory(ev: Omit<HistoryEvent, "id" | "ts"> & { ts?: number }) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    const list: HistoryEvent[] = raw ? JSON.parse(raw) : [];
    const next: HistoryEvent = {
      id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
      ts: ev.ts ?? Date.now(),
      kind: ev.kind,
      title: ev.title,
      meta: ev.meta,
    };
    const trimmed = [next, ...list].slice(0, MAX_HISTORY);
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
    window.dispatchEvent(new CustomEvent("kaka:history"));
  } catch {
    // ignore
  }
}

export function useHistory(): HistoryEvent[] {
  const [list, setList] = useState<HistoryEvent[]>([]);
  useEffect(() => {
    const read = () => {
      try {
        const raw = window.localStorage.getItem(HISTORY_KEY);
        setList(raw ? (JSON.parse(raw) as HistoryEvent[]) : []);
      } catch {
        setList([]);
      }
    };
    read();
    window.addEventListener("kaka:history", read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener("kaka:history", read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return list;
}

export function clearHistory() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(HISTORY_KEY);
  window.dispatchEvent(new CustomEvent("kaka:history"));
}

export function readHistory(): HistoryEvent[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as HistoryEvent[]) : [];
  } catch {
    return [];
  }
}

/** Union remote events (from another device via KV sync) with local ones by
 *  id, newest first — so captures made on the phone show up on the laptop
 *  instead of each device keeping half the log. */
export function mergeHistory(remote: HistoryEvent[]) {
  if (typeof window === "undefined" || remote.length === 0) return;
  try {
    const local = readHistory();
    const byId = new Map<string, HistoryEvent>();
    for (const ev of [...local, ...remote]) {
      if (ev && typeof ev.id === "string" && !byId.has(ev.id)) byId.set(ev.id, ev);
    }
    const merged = [...byId.values()].sort((a, b) => b.ts - a.ts).slice(0, MAX_HISTORY);
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(merged));
    window.dispatchEvent(new CustomEvent("kaka:history"));
  } catch {
    // ignore
  }
}

const KIND_LABEL: Record<HistoryKind, string> = {
  captured: "Captured",
  todo_created: "Todo created",
  todo_completed: "Todo completed",
  todo_uncompleted: "Todo uncompleted",
  todo_deleted: "Todo deleted",
  todo_rescheduled: "Todo rescheduled",
  habit_created: "Habit created",
  habit_checkin: "Habit check-in",
  habit_uncheck: "Habit unchecked",
  habit_deleted: "Habit deleted",
  day_planned: "Day planned",
  day_review: "Day closed",
  logged: "Logged",
  learning: "Learning",
  journal: "Journal",
};

export function kindLabel(k: HistoryKind): string {
  return KIND_LABEL[k];
}

export const KIND_CATEGORIES: { id: "all" | "todos" | "habits" | "captured"; label: string; kinds: HistoryKind[] | null }[] = [
  { id: "all", label: "All", kinds: null },
  {
    id: "todos",
    label: "Todos",
    kinds: ["todo_created", "todo_completed", "todo_uncompleted", "todo_deleted", "todo_rescheduled"],
  },
  {
    id: "habits",
    label: "Habits",
    kinds: ["habit_created", "habit_checkin", "habit_uncheck", "habit_deleted"],
  },
  { id: "captured", label: "Captured", kinds: ["captured", "logged", "learning", "journal"] },
];

/** LLM-friendly markdown export. One section per day, bullet per event,
 *  ISO timestamps, structured meta inline. */
export function exportHistoryMarkdown(list: HistoryEvent[], username: string): string {
  const lines: string[] = [];
  lines.push(`# Kaka activity log — ${username || "user"}`);
  lines.push("");
  lines.push(`Exported: ${new Date().toISOString()}`);
  lines.push(`Total events: ${list.length}`);
  lines.push("");
  lines.push("Each entry: `- [ISO timestamp] KIND — title — meta:{...}`");
  lines.push("");

  // Group by local date desc.
  const groups = new Map<string, HistoryEvent[]>();
  for (const ev of list) {
    const d = new Date(ev.ts);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day)!.push(ev);
  }
  for (const [day, events] of groups) {
    lines.push(`## ${day}`);
    for (const ev of events) {
      const iso = new Date(ev.ts).toISOString();
      const meta = ev.meta && Object.keys(ev.meta).length > 0 ? ` meta:${JSON.stringify(ev.meta)}` : "";
      lines.push(`- [${iso}] ${kindLabel(ev.kind)} — ${ev.title}${meta}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function downloadHistory(list: HistoryEvent[], username: string) {
  const md = exportHistoryMarkdown(list, username);
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `kaka-history-${stamp}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function downloadHistoryJSON(list: HistoryEvent[], username: string) {
  const payload = {
    user: username || "user",
    exportedAt: new Date().toISOString(),
    schema: {
      kind: "string (todo_*|habit_*|captured)",
      ts: "epoch milliseconds",
      title: "string",
      meta: "optional object",
    },
    events: list,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `kaka-history-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
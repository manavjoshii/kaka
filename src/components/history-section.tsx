import { useState } from "react";
import { Download, History as HistoryIcon } from "lucide-react";
import {
  clearHistory,
  downloadHistory,
  downloadHistoryJSON,
  kindLabel,
  KIND_CATEGORIES,
  type HistoryEvent,
  type HistoryKind,
} from "@/lib/history";

export function HistorySection({
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

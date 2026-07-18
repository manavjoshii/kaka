import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import ICAL from "ical.js";
import { getCfEnv } from "./cf-context.server";

const SETTINGS_KEY = "kaka:settings:v1";
const ICS_CACHE_KEY = "kaka:ics-cache:v1";
const ICS_CACHE_MS = 10 * 60 * 1000;

type Settings = { icsUrl?: string };

async function readSettings(): Promise<Settings> {
  const kv = getCfEnv().KAKA_KV;
  if (!kv) return {};
  try {
    const raw = await kv.get(SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as Settings) : {};
  } catch {
    return {};
  }
}

export const getSettings = createServerFn({ method: "GET" }).handler(async () => {
  return readSettings();
});

export const saveSettings = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ icsUrl: z.string() }).parse(d))
  .handler(async ({ data }) => {
    const kv = getCfEnv().KAKA_KV;
    if (!kv) return { saved: false };
    const url = data.icsUrl.trim();
    if (url && !/^https:\/\//.test(url)) throw new Error("Calendar URL must start with https://");
    const settings = await readSettings();
    settings.icsUrl = url || undefined;
    await kv.put(SETTINGS_KEY, JSON.stringify(settings));
    return { saved: true };
  });

export type CalendarEvent = {
  title: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
};

/** Today's events from the user's Google Calendar "secret address" ICS feed.
 *  The client passes its own local-midnight window so the Worker's UTC clock
 *  never decides what "today" means. Raw ICS is cached in KV for 10 minutes. */
export const getTodayEvents = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ startMs: z.number(), endMs: z.number() }).parse(d),
  )
  .handler(async ({ data }): Promise<CalendarEvent[] | null> => {
    const kv = getCfEnv().KAKA_KV;
    const { icsUrl } = await readSettings();
    if (!icsUrl) return null;

    let ics: string | null = null;
    if (kv) {
      try {
        const cached = await kv.get(ICS_CACHE_KEY);
        if (cached) {
          const parsed = JSON.parse(cached) as { fetchedAt: number; url: string; body: string };
          if (parsed.url === icsUrl && Date.now() - parsed.fetchedAt < ICS_CACHE_MS) {
            ics = parsed.body;
          }
        }
      } catch {
        // cache miss
      }
    }
    if (!ics) {
      const res = await fetch(icsUrl, { headers: { accept: "text/calendar" } });
      if (!res.ok) throw new Error(`Calendar fetch failed (${res.status})`);
      ics = await res.text();
      if (kv) {
        await kv.put(
          ICS_CACHE_KEY,
          JSON.stringify({ fetchedAt: Date.now(), url: icsUrl, body: ics }),
          { expirationTtl: 60 * 60 },
        );
      }
    }

    const events: CalendarEvent[] = [];
    try {
      const comp = new ICAL.Component(ICAL.parse(ics));
      for (const vtz of comp.getAllSubcomponents("vtimezone")) {
        ICAL.TimezoneService.register(new ICAL.Timezone(vtz));
      }
      for (const vevent of comp.getAllSubcomponents("vevent")) {
        const ev = new ICAL.Event(vevent);
        try {
          if (ev.isRecurring()) {
            // Iterate from the event's own DTSTART: handing iterator() a
            // start time makes ical.js stamp occurrences with that argument's
            // time-of-day, corrupting the result. Skipping is cheap.
            const iter = ev.iterator();
            let next: ICAL.Time | null;
            let guard = 0;
            while ((next = iter.next()) && guard++ < 1000) {
              const occ = ev.getOccurrenceDetails(next);
              const s = occ.startDate.toJSDate().getTime();
              if (s >= data.endMs) break;
              const e = occ.endDate.toJSDate().getTime();
              if (e > data.startMs) {
                events.push({
                  title: ev.summary || "(busy)",
                  startMs: s,
                  endMs: e,
                  allDay: occ.startDate.isDate,
                });
              }
            }
          } else {
            const s = ev.startDate?.toJSDate().getTime();
            const e = ev.endDate?.toJSDate().getTime() ?? s;
            if (s != null && s < data.endMs && (e ?? s) > data.startMs) {
              events.push({
                title: ev.summary || "(busy)",
                startMs: s,
                endMs: e ?? s,
                allDay: ev.startDate.isDate,
              });
            }
          }
        } catch {
          // one malformed event shouldn't kill the whole strip
        }
      }
    } catch (err) {
      console.error("ICS parse failed:", err);
      return [];
    }
    events.sort((a, b) => a.startMs - b.startMs);
    return events.slice(0, 20);
  });

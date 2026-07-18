import {
  buildPushPayload,
  type PushSubscription as WebPushSubscription,
} from "@block65/webcrypto-web-push";
import { getCfEnv } from "./cf-context.server";
import { VAPID_PUBLIC_KEY } from "./vapid";
import { PUSH_CONTACT } from "../config";

const SUBS_KEY = "kaka:push-subs:v1";
const DELIVERED_KEY = "kaka:delivered-alarms:v1";
const STATE_KEY = "kaka:state:v1";
// Fire alarms up to 30 min late (a missed cron run shouldn't eat a reminder),
// never early.
const LATE_WINDOW_MS = 30 * 60 * 1000;

export type StoredSub = WebPushSubscription & { label?: string; addedAt: number };

export async function readSubs(): Promise<StoredSub[]> {
  const kv = getCfEnv().KAKA_KV;
  if (!kv) return [];
  try {
    const raw = await kv.get(SUBS_KEY);
    return raw ? (JSON.parse(raw) as StoredSub[]) : [];
  } catch {
    return [];
  }
}

export async function writeSubs(subs: StoredSub[]) {
  const kv = getCfEnv().KAKA_KV;
  if (!kv) return;
  await kv.put(SUBS_KEY, JSON.stringify(subs.slice(-10)));
}

/** Send one notification to every registered device. Subscriptions the push
 *  service reports as gone (404/410) are dropped so the list self-heals. */
export async function sendPushToAll(message: {
  title: string;
  body?: string;
  tag?: string;
  url?: string;
}) {
  const privateKey = getCfEnv().VAPID_PRIVATE_KEY ?? process.env.VAPID_PRIVATE_KEY;
  if (!privateKey) {
    console.error("Push skipped: VAPID_PRIVATE_KEY not set");
    return { sent: 0, total: 0 };
  }
  const subs = await readSubs();
  if (subs.length === 0) return { sent: 0, total: 0 };

  const vapid = {
    subject: PUSH_CONTACT,
    publicKey: VAPID_PUBLIC_KEY,
    privateKey,
  };
  const gone: string[] = [];
  let sent = 0;
  for (const sub of subs) {
    try {
      const payload = await buildPushPayload(
        { data: JSON.stringify(message), options: { ttl: 3600 } },
        sub,
        vapid,
      );
      const res = await fetch(sub.endpoint, payload as RequestInit);
      if (res.status === 404 || res.status === 410) gone.push(sub.endpoint);
      else if (res.ok || res.status === 201) sent++;
      else console.error(`Push to ${new URL(sub.endpoint).host} failed: ${res.status}`);
    } catch (err) {
      console.error("Push send error:", err);
    }
  }
  if (gone.length > 0) {
    await writeSubs(subs.filter((s) => !gone.includes(s.endpoint)));
  }
  return { sent, total: subs.length };
}

/** Cron entry point: push a notification for every task whose reminder time
 *  has arrived. Delivered alarms are tracked as `id:dueAt`, so rescheduling a
 *  task re-arms its reminder instead of staying silent forever. */
export async function deliverDueAlarms() {
  const kv = getCfEnv().KAKA_KV;
  if (!kv) return;

  const [stateRaw, deliveredRaw] = await Promise.all([
    kv.get(STATE_KEY),
    kv.get(DELIVERED_KEY),
  ]);
  if (!stateRaw) return;

  type TodoLike = {
    id: string;
    title: string;
    done: boolean;
    dueAt?: number;
    alarmLeadMin?: number;
  };
  let state: { todos?: TodoLike[]; tz?: string };
  try {
    state = JSON.parse(stateRaw);
  } catch {
    return;
  }
  const delivered: string[] = deliveredRaw ? JSON.parse(deliveredRaw) : [];
  const deliveredSet = new Set(delivered);

  const now = Date.now();
  const due = (state.todos ?? []).filter((t) => {
    if (t.done || typeof t.dueAt !== "number") return false;
    // Reminders are on by default: no alarmLeadMin means 10 min before;
    // -1 means the user muted this task's reminder.
    const lead = typeof t.alarmLeadMin === "number" ? t.alarmLeadMin : 10;
    if (lead < 0) return false;
    const alarmAt = t.dueAt - lead * 60_000;
    return alarmAt <= now && alarmAt > now - LATE_WINDOW_MS && !deliveredSet.has(`${t.id}:${t.dueAt}`);
  });
  if (due.length === 0) return;

  const tz = state.tz ?? "Asia/Kolkata";
  for (const t of due) {
    const timeStr = new Date(t.dueAt!).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: tz,
    });
    await sendPushToAll({
      title: t.title,
      body: `Due at ${timeStr}`,
      tag: `alarm-${t.id}`,
    });
  }
  const newDelivered = [...delivered, ...due.map((t) => `${t.id}:${t.dueAt}`)].slice(-500);
  await kv.put(DELIVERED_KEY, JSON.stringify(newDelivered));
}

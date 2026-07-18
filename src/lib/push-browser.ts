import { VAPID_PUBLIC_KEY } from "./vapid";

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch (err) {
    console.error("SW registration failed:", err);
    return null;
  }
}

/** Ask permission and subscribe this device. Must be called from a user
 *  gesture (iOS requirement). Returns the subscription JSON to store, or
 *  throws with a human-readable reason. */
export async function subscribeToPush(): Promise<{
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
}> {
  if (!pushSupported()) {
    throw new Error(
      "This browser can't do push. On iPhone, open Kaka from the Home Screen icon (re-add it via Share → Add to Home Screen if needed).",
    );
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notifications were not allowed. Enable them in Settings if you change your mind.");
  }
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await registerServiceWorker());
  if (!reg) throw new Error("Couldn't register the background worker.");
  await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
    }));
  return sub.toJSON() as {
    endpoint: string;
    expirationTime: number | null;
    keys: { p256dh: string; auth: string };
  };
}

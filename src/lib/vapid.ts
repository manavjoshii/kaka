// Web-push VAPID public key. Public by design — it is embedded in every push
// subscription the browser creates. The matching private key lives only in
// the Worker secret VAPID_PRIVATE_KEY. Both are yours to generate — see
// src/config.ts.
export { VAPID_PUBLIC_KEY } from "../config";

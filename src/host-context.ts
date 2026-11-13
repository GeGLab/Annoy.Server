import { AsyncLocalStorage } from "node:async_hooks";

// Set only by the loopback + host-token protected dashboard dispatcher. It is
// deliberately independent of request headers and of normal user sessions.
export const hostActor = new AsyncLocalStorage<string>();

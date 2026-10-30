// Front door for updates without downtime (the "proxy" Compose service). Two
// server containers take turns: the updater starts the new version next to
// the running one, writes its name to /control/active once it answers, and
// stops the old one. New connections follow that file; when the old process
// closes, clients reconnect at once (gateway code 4010) and land on the new
// one. Plain TCP, so HTTP and WebSocket pass through untouched.
import { readFileSync } from "node:fs";
import { createServer, connect, type Socket } from "node:net";

const port = Number(process.env.ANNOY_PROXY_PORT ?? 8787);
const backendPort = Number(process.env.ANNOY_PROXY_BACKEND_PORT ?? 8787);
const backends = (process.env.ANNOY_PROXY_BACKENDS ?? "annoy,annoy-b").split(",");
const activeFile = `${process.env.ANNOY_CONTROL_DIR ?? "/control"}/active`;

let active = backends[0]!;
function refresh() {
  try {
    const name = readFileSync(activeFile, "utf8").trim();
    if (backends.includes(name)) active = name;
  } catch {
    // No file yet: the first backend serves.
  }
}
refresh();
setInterval(refresh, 500).unref();

/** The active backend first; the other one if it refuses (e.g. restarted by hand). */
function open(client: Socket, order: string[]) {
  const [host, ...rest] = order;
  if (!host || client.destroyed) return void client.destroy();
  const upstream = connect(backendPort, host);
  const tryNext = () => open(client, rest);
  upstream.once("error", tryNext);
  upstream.once("connect", () => {
    upstream.off("error", tryNext);
    upstream.setNoDelay(true);
    upstream.on("error", () => client.destroy());
    upstream.on("close", () => client.destroy());
    client.on("close", () => upstream.destroy());
    client.pipe(upstream).pipe(client);
    client.resume();
  });
}

createServer({ pauseOnConnect: true, noDelay: true }, (client) => {
  client.on("error", () => client.destroy());
  open(client, [active, ...backends.filter((b) => b !== active)]);
}).listen(port, () =>
  console.log(`annoy proxy: :${port} → ${backends.join(" | ")} (active: ${active})`),
);

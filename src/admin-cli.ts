// annoy-admin: administers this annoy-server from its host (TODO item 5).
// Settings are Compose flags in .env; this command covers what flags can't:
// sign-up invites, bans, deleting accounts or servers, and updates.
//
//   Docker:  ./scripts/annoy-admin.sh <command>      (on the host)
//   Node:    npm run admin -- <command>              (same machine as the server)
//
// It talks to the running server over 127.0.0.1 with the token in the data
// folder, so bans and deletions take effect for connected people at once.
import { readFileSync } from "node:fs";
import type { AdminOverview, AdminServer, AdminUser, SignupInvite, UpdateStatus } from "@distopic/protocol";
import { ADMIN_TOKEN_HEADER, adminTokenPath } from "./admin-control.ts";
import { config } from "./config.ts";

const HELP = `annoy-admin — administração do annoy-server

Configurações (cadastro, limites, admin, atualização automática) ficam no .env:
  ANNOY_REGISTRATION=open|invite|closed  ANNOY_MAX_UPLOAD_MB  ANNOY_MAX_SERVERS_PER_USER
  ANNOY_ADMIN=<usuário>  ANNOY_AUTO_UPDATE=on|off   (depois: docker compose up -d)

Comandos:
  status                                  Resumo do annoy-server
  invite list                             Convites de cadastro
  invite create [--uses N] [--hours H]    Cria um convite de cadastro
  invite revoke <código>                  Apaga um convite
  user list [busca]                       Contas
  user ban <usuário> [motivo]             Suspende a conta e desconecta
  user unban <usuário>                    Reativa a conta
  user delete <usuário> --yes             Apaga a conta
  server list                             Servidores deste annoy-server
  server delete <id> --yes                Apaga um servidor
  update status                           Versão atual e disponível
  update apply                            Atualiza agora (precisa do serviço updater)
`;

function token(): string {
  try {
    return readFileSync(adminTokenPath(), "utf8").trim();
  } catch {
    fail(`Sem acesso a ${adminTokenPath()}. Rode no host do annoy-server (Docker: ./scripts/annoy-admin.sh).`);
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `http://127.0.0.1:${process.env.ANNOY_ADMIN_PORT ?? config.port}/api/admin${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { [ADMIN_TOKEN_HEADER]: token(), ...(body !== undefined && { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    fail(`O annoy-server não respondeu em ${url}. Ele está rodando?`);
  }
  const data = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) fail(data.message ?? `Erro ${res.status}`);
  return data as T;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

function table(rows: (string | number)[][]): void {
  if (!rows.length) return void console.log("(nada)");
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  for (const row of rows) console.log(row.map((cell, c) => String(cell).padEnd(widths[c]!)).join("  ").trimEnd());
}

const day = (iso: string | null) => (iso ? iso.slice(0, 16).replace("T", " ") : "—");

async function main(argv: string[]): Promise<void> {
  const [group, action, ...rest] = argv;
  const args = [...rest];
  const sure = args.includes("--yes");
  const plain = args.filter((a) => a !== "--yes");
  switch (`${group ?? ""} ${action ?? ""}`.trim()) {
    case "status": {
      const o = await call<AdminOverview>("GET", "/overview");
      console.log(`Cadastro: ${o.settings.registration} · upload até ${o.settings.maxUploadMb} MB · servidores por conta: ${o.settings.maxServersPerUser ?? "sem limite"}`);
      console.log(`Contas: ${o.userCount} · servidores: ${o.serverCount} · mensagens: ${o.messageCount} · arquivos: ${(o.uploadsBytes / 1e6).toFixed(1)} MB`);
      if (o.voiceUsage) console.log(`Voz (Cloudflare, ${o.voiceUsage.month}): ${(o.voiceUsage.bytes / 1e9).toFixed(2)} GB`);
      return;
    }
    case "invite list": {
      const list = await call<SignupInvite[]>("GET", "/invites");
      return table([["CÓDIGO", "USOS", "EXPIRA"], ...list.map((i) => [i.code, `${i.uses}/${i.maxUses ?? "∞"}`, day(i.expiresAt)])]);
    }
    case "invite create": {
      const uses = flag(args, "--uses"), hours = flag(args, "--hours");
      const invite = await call<SignupInvite>("POST", "/invites", { maxUses: uses ? Number(uses) : null, expiresInHours: hours ? Number(hours) : null });
      return void console.log(invite.code);
    }
    case "invite revoke": {
      if (!plain[0]) fail("Informe o código.");
      await call("DELETE", `/invites/${encodeURIComponent(plain[0])}`);
      return void console.log("Convite apagado.");
    }
    case "user list": {
      const list = await call<AdminUser[]>("GET", `/users?q=${encodeURIComponent(plain.join(" "))}`);
      return table([["USUÁRIO", "NOME", "ADMIN", "SUSPENSA", "SERVIDORES"], ...list.map((u) => [u.user.username, u.user.displayName, u.isAdmin ? "sim" : "", u.bannedAt ? day(u.bannedAt) : "", u.serverCount])]);
    }
    case "user ban": {
      if (!plain[0]) fail("Informe o usuário.");
      await call("POST", `/users/${encodeURIComponent(plain[0])}/ban`, { reason: plain.slice(1).join(" ") || undefined });
      return void console.log("Conta suspensa.");
    }
    case "user unban": {
      if (!plain[0]) fail("Informe o usuário.");
      await call("DELETE", `/users/${encodeURIComponent(plain[0])}/ban`);
      return void console.log("Conta reativada.");
    }
    case "user delete": {
      if (!plain[0]) fail("Informe o usuário.");
      if (!sure) fail("Apagar uma conta não tem volta. Repita com --yes.");
      await call("DELETE", `/users/${encodeURIComponent(plain[0])}`);
      return void console.log("Conta apagada.");
    }
    case "server list": {
      const list = await call<AdminServer[]>("GET", "/servers");
      return table([["ID", "NOME", "DONO", "MEMBROS", "CANAIS"], ...list.map((s) => [s.server.id, s.server.name, s.owner?.username ?? "—", s.memberCount, s.channelCount])]);
    }
    case "server delete": {
      if (!plain[0]) fail("Informe o id do servidor (veja: server list).");
      if (!sure) fail("Apagar um servidor não tem volta. Repita com --yes.");
      await call("DELETE", `/servers/${encodeURIComponent(plain[0])}`);
      return void console.log("Servidor apagado.");
    }
    case "update status": {
      const u = await call<UpdateStatus>("GET", "/updates");
      console.log(`Versão: ${u.current} · mais nova: ${u.latest ?? "?"} · automática: ${u.auto ? "sim" : "não"} (ANNOY_AUTO_UPDATE)`);
      if (!u.available) console.log("O serviço updater não está rodando.");
      return;
    }
    case "update apply": {
      await call("POST", "/updates/apply", {});
      return void console.log("Atualização pedida ao updater.");
    }
    default:
      console.log(HELP);
      if (group && group !== "help" && group !== "--help") process.exit(1);
  }
}

await main(process.argv.slice(2));

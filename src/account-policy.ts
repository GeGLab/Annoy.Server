import { config } from "./config.ts";
import { one, run, tx } from "./db.ts";
import { HttpError } from "./errors.ts";

export function requireAccountMode(mode: "global" | "local"): void {
  if (config.accountMode !== mode || one<{ value: string }>("SELECT value FROM instance_settings WHERE key = 'auth.accountMode'")?.value !== mode) throw new HttpError(403, "account_mode", mode === "local"
    ? "Este servidor exige uma conta Annoy. Cadastre-se ou entre para migrar sua conta."
    : "Este servidor usa apenas contas locais e não se comunica com o serviço de contas Annoy.");
}

/** Startup never changes identities, passwords or existing sessions. */
export function applyAccountMode(): void {
  tx(() => {
    const previous = one<{ value: string }>("SELECT value FROM instance_settings WHERE key = 'auth.accountMode'")?.value;
    if (previous && previous !== config.accountMode) {
      throw new Error("account_mode_migration_required: configured mode differs from persisted mode; restore the previous configuration and plan an explicit migration");
    }
    if (!previous) {
      if (one("SELECT 1 FROM users LIMIT 1")) {
        throw new Error("account_mode_migration_required: existing database has no recorded account mode; explicit migration is required");
      }
      run("INSERT INTO instance_settings (key, value) VALUES ('auth.accountMode', ?)", config.accountMode);
    }
  });
}

applyAccountMode();

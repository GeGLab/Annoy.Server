// Run on the host only, after independently verifying the account owner.
import { randomBytes } from "node:crypto";
import { hashToken } from "../src/auth.ts";
import { db, one, run } from "../src/db.ts";

const username = process.argv[2];
if (!username) throw new Error("Usage: npm run account:recover -- <username>");
const user = one<{ id: string }>("SELECT id FROM users WHERE username = ? AND banned_at IS NULL AND username NOT LIKE 'deleted.%'", username);
if (!user) throw new Error("Active account not found");
const code = randomBytes(32).toString("base64url");
run("INSERT INTO account_recovery (user_id, token_hash, expires_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash, expires_at = excluded.expires_at",
  user.id, hashToken(code), new Date(Date.now() + 30 * 60_000).toISOString());
console.log(`Recovery code for @${username} (one use, expires in 30 minutes): ${code}`);
db.close();

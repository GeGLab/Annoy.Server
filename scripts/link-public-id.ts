// Run on the host only. Links an existing user to an Annoy account by its Global public ID:
// the next Annoy login of that account here opens this user (history and roles kept).
import { db, one, run } from "../src/db.ts";

const [username, publicId] = process.argv.slice(2);
if (!username || !publicId || !/^[A-Za-z0-9]{6,32}$/.test(publicId)) throw new Error("Usage: npm run account:link -- <username> <publicId>");
const user = one<{ id: string }>("SELECT id FROM users WHERE username = ? AND banned_at IS NULL", username);
if (!user) throw new Error("Active account not found");
const holder = one<{ username: string }>("SELECT username FROM users WHERE global_public_id = ? AND id <> ?", publicId, user.id);
if (holder) throw new Error(`Public ID already linked to @${holder.username}`);
// Unlink the old per-server identity so the next login re-binds by public ID.
run("UPDATE users SET global_public_id = ?, global_id = NULL WHERE id = ?", publicId, user.id);
run("DELETE FROM sessions WHERE user_id = ?", user.id);
console.log(`@${username} linked to Annoy account ${publicId}. Sign in with that Annoy account.`);
db.close();

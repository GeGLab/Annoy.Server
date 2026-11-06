import { config } from '../src/config.ts';
import { databaseFile } from '../src/db-file.ts';
import { applyModeMigration, planModeMigration } from '../src/account-mode-migration.ts';
const [action, from, to, expected, backup] = process.argv.slice(2);
if ((action !== 'plan' && action !== 'apply') || (from !== 'global' && from !== 'local') || (to !== 'global' && to !== 'local')) {
  throw new Error('Usage: npm run account:mode -- plan <from> <to> | apply <from> <to> <fingerprint> <new-backup-path>');
}
const path = databaseFile(config.dataDir);
if (action === 'plan') console.log(JSON.stringify(planModeMigration(path, from, to), null, 2));
else {
  if (!expected || !backup) throw new Error('Plan fingerprint and new backup path required');
  await applyModeMigration(path, from, to, expected, backup);
  console.log('Mode migrated. Configure ANNOY_ACCOUNT_MODE=' + to + ' before restarting. Accounts require explicit enrollment.');
}

import {config} from '../src/config.ts';
import {applyLegacyPurge,planLegacyPurge,restoreLegacySource} from '../src/legacy-migration.ts';
const [operation,selected,fingerprint,backup]=process.argv.slice(2),channels=(selected??'').split(',').filter(Boolean);
if(operation==='plan')console.log(JSON.stringify(await planLegacyPurge(config.dataDir,channels),null,2));
else if(operation==='apply'&&fingerprint&&backup){await applyLegacyPurge(config.dataDir,channels,fingerprint,backup);console.log('Selected plaintext source removed. Encrypted delivery, identities and permissions preserved. The validated backup still contains legacy plaintext; apply its retention policy separately.');}
else if(operation==='restore'&&fingerprint&&backup){await restoreLegacySource(config.dataDir,fingerprint,channels,backup);console.log('Legacy source restored without rewinding MLS epochs or authentication identities. All sessions must authenticate again.');}
else throw new Error('Usage: content:legacy plan channel[,channel] | apply channel[,channel] fingerprint NEW-backup-directory | restore channel[,channel] source-backup-directory NEW-current-backup-directory');

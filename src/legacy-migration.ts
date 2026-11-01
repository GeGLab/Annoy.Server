// Offline administrative content migration. Never imported by HTTP routes.
import {createHash,createPublicKey,verify} from 'node:crypto';
import {createReadStream,constants,closeSync,openSync} from 'node:fs';
import {chmod,copyFile,lstat,mkdir,open as openFile,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises';
import {dirname,join,relative,resolve,sep} from 'node:path';
import {backup,DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {acquireDataLock} from './data-lock.ts';
import {fingerprint} from './account-mode-migration.ts';
import {legacyManifest,legacyFileDigest,legacyReaders,type LegacyManifest} from './legacy-manifest.ts';
interface FileEntry {path:string;size:number;sha256:string}
interface ChannelPlan extends LegacyManifest {fileDigest:string;readers:string[];missingReaders:string[]}
interface Snapshot {version:1;databaseFingerprint:string;files:FileEntry[]}
export interface LegacyPlan extends Snapshot {fingerprint:string;channels:ChannelPlan[];ready:boolean;unclassifiedFiles:string[];warning:string}
const dbPath=(directory:string)=>join(directory,'distopic.db');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"';
async function shaFile(path:string):Promise<string>{const hash=createHash('sha256');for await(const bytes of createReadStream(path))hash.update(bytes);return hash.digest('hex');}
async function filesUnder(directory:string):Promise<FileEntry[]>{
 const files:FileEntry[]=[];
 const walk=async(path:string,prefix:string)=>{for(const entry of (await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const source=join(path,entry.name),name=prefix?prefix+'/'+entry.name:entry.name;
  if(entry.isSymbolicLink())throw new Error('Symbolic links require explicit review before content migration');
  if(entry.isDirectory())await walk(source,name);else if(entry.isFile()){const stat=await lstat(source);files.push({path:name,size:stat.size,sha256:await shaFile(source)});}else throw new Error('Unsupported upload filesystem entry');
 }};
 let root;try{root=await lstat(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
 if(!root.isDirectory()||root.isSymbolicLink())throw new Error('Upload root requires explicit review');
 await walk(directory,'');return files;
}
async function flush(path:string,directory=false):Promise<void>{
 if(directory&&process.platform==='win32')return;const file=await openFile(path,directory?'r':'r+');try{await file.sync();}finally{await file.close();}
}
function validateReferencedFiles(db:DatabaseSync,files:FileEntry[]):void{
 const indexed=new Map(files.map(f=>[f.path,f]));
 for(const table of ['attachments','crypto_blobs'])if(db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(table))for(const row of db.prepare('SELECT id,size FROM '+quote(table)).iterate()){
  const file=indexed.get(String(row.id)+'/blob');if(!file||file.size!==Number(row.size))throw new Error('Referenced attachment is missing or incomplete; source preserved');
 }
}
function receiptValid(db:DatabaseSync,channel:ChannelPlan,userId:string,instance:string):boolean {
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_archive_receipts'").get())return false;
 const row=db.prepare('SELECT r.*,d.public_key,d.revoked_at,d.user_id AS device_user FROM legacy_archive_receipts r JOIN crypto_devices d ON d.id=r.device_id WHERE r.channel_id=? AND r.user_id=?').get(channel.channelId,userId);
 if(!row||row.revoked_at||row.device_user!==userId||row.fingerprint!==channel.fingerprint||row.file_digest!==channel.fileDigest||row.messages!==channel.messages||row.attachments!==channel.attachments)return false;
 try{return verify(null,Buffer.from(JSON.stringify(['annoy/legacy/archive/v1',instance,userId,channel.channelId,row.device_id,channel.fingerprint,channel.fileDigest,channel.messages,channel.attachments])),createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:String(row.public_key)},format:'jwk'}),Buffer.from(String(row.signature),'base64url'));}catch{return false;}
}
async function inspect(directory:string,channelIds:string[]):Promise<LegacyPlan>{
 if(!channelIds.length||channelIds.length>1000||new Set(channelIds).size!==channelIds.length||channelIds.some(id=>!id||id.length>100))throw new Error('Explicit unique channel selection required');
 const db=new DatabaseSync(dbPath(directory),{readOnly:true});
 try{
  db.exec('BEGIN');if(db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')throw new Error('Source database integrity failed');
  const databaseFingerprint=fingerprint(db),files=await filesUnder(join(directory,'uploads')),channels:ChannelPlan[]=[];validateReferencedFiles(db,files);
  const instance=String(db.prepare("SELECT value FROM instance_settings WHERE key='crypto.instanceId'").get()?.value??'');
  for(const id of [...channelIds].sort()){
   if(!db.prepare('SELECT 1 FROM crypto_channels WHERE channel_id=?').get(id))throw new Error('Activate MLS before planning plaintext removal');
   const source=legacyManifest(db,id),fileDigest=await legacyFileDigest(db,id,join(directory,'uploads'));
   const channel:ChannelPlan={...source,fileDigest,readers:legacyReaders(db,id),missingReaders:[]};
   channel.missingReaders=channel.messages?channel.readers.filter(user=>!receiptValid(db,channel,user,instance)):[];
   if(channel.messages&&!channel.readers.length)channel.missingReaders=['no_current_reader'];channels.push(channel);
  }
  const known=new Set<string>();for(const table of ['attachments','crypto_blobs','crypto_blob_gc'])if(db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(table))for(const row of db.prepare('SELECT id FROM '+quote(table)).iterate())known.add(String(row.id)+'/blob');
  return {version:1,databaseFingerprint,files,channels,ready:channels.every(c=>!c.missingReaders.length),unclassifiedFiles:files.filter(f=>!known.has(f.path)).map(f=>f.path),fingerprint:hash(JSON.stringify({databaseFingerprint,files,channels})),warning:'Offline operation. Current readers must hold verified encrypted local copies. A new validated backup of SQLite and all uploads is mandatory. Backup remains legacy plaintext and needs separate retention control. Unclassified files are retained.'};
 }finally{db.close();}
}
export async function planLegacyPurge(directory:string,channelIds:string[]):Promise<LegacyPlan>{const release=acquireDataLock(directory);try{return await inspect(directory,channelIds);}finally{release();}}
async function makeBackup(directory:string,target:string):Promise<Snapshot>{
 const sourceRoot=await realpath(directory),parent=await realpath(dirname(resolve(target))),canonicalTarget=join(parent,relative(dirname(resolve(target)),resolve(target)));
 if(canonicalTarget===sourceRoot||canonicalTarget.startsWith(sourceRoot+sep))throw new Error('Backup must be outside the source data directory');
 await mkdir(target,{mode:0o700});let complete=false;
 try{
  const source=new DatabaseSync(dbPath(directory),{readOnly:true});let databaseFingerprint:string;
  try{databaseFingerprint=fingerprint(source);closeSync(openSync(join(target,'server.sqlite'),'wx',0o600));await backup(source,join(target,'server.sqlite'));}finally{source.close();}
  const copied=new DatabaseSync(join(target,'server.sqlite'),{readOnly:true});try{if(copied.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok'||fingerprint(copied)!==databaseFingerprint)throw new Error('SQLite backup validation failed');}finally{copied.close();}
  await flush(join(target,'server.sqlite'));const files=await filesUnder(join(directory,'uploads'));
  for(const file of files){const destination=join(target,'uploads',...file.path.split('/'));await mkdir(dirname(destination),{recursive:true,mode:0o700});await copyFile(join(directory,'uploads',...file.path.split('/')),destination,constants.COPYFILE_EXCL);if(await shaFile(destination)!==file.sha256)throw new Error('Upload backup validation failed');await chmod(destination,0o600);await flush(destination);}
  const current=new DatabaseSync(dbPath(directory),{readOnly:true});try{validateReferencedFiles(current,files);if(fingerprint(current)!==databaseFingerprint||JSON.stringify(await filesUnder(join(directory,'uploads')))!==JSON.stringify(files))throw new Error('Source changed during backup');}finally{current.close();}
  const manifest:Snapshot={version:1,databaseFingerprint,files};await writeFile(join(target,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600,flush:true});const directories=new Set<string>([target]);for(const file of files){let path=dirname(join(target,'uploads',...file.path.split('/')));while(path.startsWith(target+sep)){directories.add(path);path=dirname(path);}}for(const path of [...directories].sort((a,b)=>b.length-a.length))await flush(path,true);await flush(dirname(resolve(target)),true);complete=true;return manifest;
 }finally{if(!complete)await rm(target,{recursive:true,force:true});}
}
export async function applyLegacyPurge(directory:string,channelIds:string[],expected:string,backupDirectory:string):Promise<void>{
 const release=acquireDataLock(directory);try{
  if(!/^[a-f0-9]{64}$/.test(expected))throw new Error('Plan fingerprint required');const plan=await inspect(directory,channelIds);
  if(plan.fingerprint!==expected)throw new Error('Source changed since planning');if(!plan.ready)throw new Error('Verified archive receipts from all current readers are required');
  const saved=await makeBackup(directory,backupDirectory);if(saved.databaseFingerprint!==plan.databaseFingerprint||JSON.stringify(saved.files)!==JSON.stringify(plan.files))throw new Error('Backup does not match approved plan');
  const db=new DatabaseSync(dbPath(directory));let blobs:string[]=[];
  try{
   db.exec('PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; BEGIN IMMEDIATE');
   if(fingerprint(db)!==plan.databaseFingerprint)throw new Error('Source changed before commit');
   for(const channelId of channelIds){
    blobs.push(...(db.prepare('SELECT a.id FROM attachments a JOIN messages m ON m.id=a.message_id WHERE m.channel_id=?').all(channelId) as {id:string}[]).map(r=>r.id));
    db.prepare('DELETE FROM messages WHERE channel_id=?').run(channelId);db.prepare('DELETE FROM legacy_archive_receipts WHERE channel_id=?').run(channelId);
    db.prepare("INSERT INTO instance_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run('crypto.legacyPurged:'+channelId,JSON.stringify({at:new Date().toISOString(),source:'legacy_plaintext'}));
   }
   // Rebuild the full-text index so erased terms are not left in FTS segments.
   if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='messages_search'").get())db.exec("INSERT INTO messages_search(messages_search) VALUES('rebuild')");
   db.exec('DELETE FROM sessions; COMMIT; PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE)');
   if(db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')throw new Error('Post-migration integrity check failed; use the validated backup');
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}finally{db.close();}
  for(const id of blobs){if(!/^[a-f0-9]{32}$/.test(id))throw new Error('Legacy blob identifier requires manual review');await rm(join(directory,'uploads',id),{recursive:true,force:true});}
 }finally{release();}
}
async function validateBackup(directory:string):Promise<Snapshot>{
 // Reject symlinks at every descendant component, including the database.
 const root=await lstat(directory);if(!root.isDirectory()||root.isSymbolicLink())throw new Error('Invalid backup root');
 const sqlite=await lstat(join(directory,'server.sqlite'));if(!sqlite.isFile()||sqlite.isSymbolicLink())throw new Error('Invalid backup database');
 const checked=new Set<string>();
 const parents=async(parts:string[])=>{let path=join(directory,'uploads');for(const part of ['',...parts]){if(part)path=join(path,part);if(checked.has(path))continue;const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Invalid backup directory');checked.add(path);}};

 const metadata=await lstat(join(directory,'manifest.json'));if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.size>64*1024*1024)throw new Error('Invalid backup manifest');
 const saved=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8')) as Snapshot;
 if(saved.version!==1||!/^[a-f0-9]{64}$/.test(saved.databaseFingerprint)||!Array.isArray(saved.files)||saved.files.length>1000000)throw new Error('Invalid backup manifest');
 for(const file of saved.files){if(!file||typeof file.path!=='string'||file.path.split('/').some(p=>!p||p==='.'||p==='..'||p.includes('\\'))||file.path.startsWith('/')||!Number.isSafeInteger(file.size)||file.size<0||!/^[a-f0-9]{64}$/.test(file.sha256))throw new Error('Invalid backup path');await parents(file.path.split('/').slice(0,-1));const path=join(directory,'uploads',...file.path.split('/')),stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==file.size||await shaFile(path)!==file.sha256)throw new Error('Upload backup integrity mismatch');}
 const db=new DatabaseSync(join(directory,'server.sqlite'),{readOnly:true});try{if(db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok'||fingerprint(db)!==saved.databaseFingerprint)throw new Error('SQLite backup integrity mismatch');}finally{db.close();}
 return saved;
}
/** Roll back ONLY the selected legacy source. Never rewind MLS epochs, device
 * revocations, accounts, permissions or encrypted delivery to an older snapshot. */
export async function restoreLegacySource(directory:string,backupDirectory:string,channelIds:string[],currentBackupDirectory:string):Promise<void>{
 const release=acquireDataLock(directory);const created:string[]=[];let committed=false;
 try{
  if(!channelIds.length||channelIds.length>1000||new Set(channelIds).size!==channelIds.length||channelIds.some(id=>!id||id.length>100))throw new Error('Explicit channel selection required');
  const saved=await validateBackup(backupDirectory),savedFiles=new Map(saved.files.map(file=>[file.path,file]));await makeBackup(directory,currentBackupDirectory);
  const source=new DatabaseSync(join(backupDirectory,'server.sqlite'),{readOnly:true}),destination=new DatabaseSync(dbPath(directory));
  try{
   destination.function('annoy_legacy_source_write',()=>1);destination.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
   const guard=destination.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='crypto_no_plaintext_insert'").get()?.sql;
   if(guard)destination.exec('DROP TRIGGER crypto_no_plaintext_insert');
   const insert=(table:string,row:Record<string,unknown>)=>{const columns=Object.keys(row);destination.prepare('INSERT INTO '+quote(table)+'('+columns.map(quote).join(',')+') VALUES('+columns.map(()=>'?').join(',')+')').run(...columns.map(c=>row[c] as SQLInputValue));};
   for(const channelId of channelIds){
    if(!destination.prepare('SELECT 1 FROM channels WHERE id=?').get(channelId))throw new Error('Original channel no longer exists; use the local archive');
    for(const row of source.prepare('SELECT * FROM messages WHERE channel_id=? ORDER BY id').iterate(channelId)){
     if(!destination.prepare('SELECT 1 FROM users WHERE id=?').get(String(row.author_id)))throw new Error('Original author no longer exists; authentication identities will not be recreated');
     const existing=destination.prepare('SELECT * FROM messages WHERE id=?').get(String(row.id));if(existing){if(JSON.stringify(existing)!==JSON.stringify(row))throw new Error('Message ID collision');}else insert('messages',row);
     for(const attachment of source.prepare('SELECT * FROM attachments WHERE message_id=?').iterate(String(row.id))){
      const id=String(attachment.id);if(!/^[a-f0-9]{32}$/.test(id))throw new Error('Unsupported legacy attachment ID');
      if(destination.prepare('SELECT 1 FROM crypto_blobs WHERE id=?').get(id)||destination.prepare('SELECT 1 FROM crypto_blob_gc WHERE id=?').get(id))throw new Error('Encrypted blob ID collision');
      const original=savedFiles.get(id+'/blob');if(!original)throw new Error('Backup missing original attachment');
      const target=join(directory,'uploads',id,'blob');let present=false;try{const stat=await lstat(target);if(!stat.isFile()||stat.isSymbolicLink()||await shaFile(target)!==original.sha256)throw new Error('Upload ID collision');present=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      if(!present){await mkdir(dirname(target),{recursive:true,mode:0o700});await copyFile(join(backupDirectory,'uploads',id,'blob'),target,constants.COPYFILE_EXCL);created.push(target);if(await shaFile(target)!==original.sha256)throw new Error('Restored attachment validation failed');await flush(target);await flush(dirname(target),true);}
      const existing=destination.prepare('SELECT * FROM attachments WHERE id=?').get(id);if(existing){if(JSON.stringify(existing)!==JSON.stringify(attachment))throw new Error('Attachment ID collision');}else insert('attachments',attachment);
     }
     if(source.prepare("SELECT 1 FROM sqlite_master WHERE name='message_reactions'").get())for(const reaction of source.prepare('SELECT * FROM message_reactions WHERE message_id=?').iterate(String(row.id))){if(!destination.prepare('SELECT 1 FROM message_reactions WHERE message_id=? AND user_id=? AND emoji=?').get(String(reaction.message_id),String(reaction.user_id),String(reaction.emoji)))insert('message_reactions',reaction);}
    }
    destination.prepare('DELETE FROM instance_settings WHERE key=?').run('crypto.legacyPurged:'+channelId);
   }
   if(guard)destination.exec(String(guard));destination.exec('DELETE FROM sessions; COMMIT');committed=true;
   if(destination.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')throw new Error('Restore validation failed; preserve both backups');
  }catch(error){if(destination.isTransaction)destination.exec('ROLLBACK');throw error;}finally{source.close();destination.close();}
 }finally{if(!committed)for(const file of created)await rm(file,{force:true});release();}
}

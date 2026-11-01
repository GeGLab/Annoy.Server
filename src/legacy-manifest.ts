import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {computePermissions,has,Permission,type Overwrite} from '@distopic/protocol';
export interface LegacyManifest {version:1;channelId:string;fingerprint:string;messages:number;attachments:number;bytes:number}
/** A commitment to the plaintext source, not a claim of historical E2EE. */
export function legacyManifest(db:DatabaseSync,channelId:string):LegacyManifest {
 const hash=createHash('sha256');let messages=0,attachments=0,bytes=0;
 hash.update(JSON.stringify(['annoy/legacy/source/v1',channelId]));
 for(const row of db.prepare('SELECT * FROM messages WHERE channel_id=? ORDER BY id').iterate(channelId)){hash.update(JSON.stringify(row));messages++;}
 for(const row of db.prepare('SELECT a.* FROM attachments a JOIN messages m ON a.message_id=m.id WHERE m.channel_id=? ORDER BY a.id').iterate(channelId)){hash.update(JSON.stringify(row));attachments++;bytes+=Number(row.size);}
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='message_reactions'").get())for(const row of db.prepare('SELECT r.* FROM message_reactions r JOIN messages m ON m.id=r.message_id WHERE m.channel_id=? ORDER BY r.message_id,r.user_id,r.emoji').iterate(channelId))hash.update(JSON.stringify(row));
 return {version:1,channelId,fingerprint:hash.digest('hex'),messages,attachments,bytes};
}
export function legacyReaders(db:DatabaseSync,channelId:string):string[]{
 const channel=db.prepare('SELECT * FROM channels WHERE id=?').get(channelId);if(!channel)throw new Error('Unknown channel');
 if(channel.type==='dm')return (db.prepare('SELECT user_id FROM dm_recipients WHERE channel_id=? ORDER BY user_id').all(channelId) as {user_id:string}[]).map(r=>r.user_id);
 const serverId=String(channel.server_id);
 const server=db.prepare('SELECT owner_id FROM servers WHERE id=?').get(serverId);if(!server)throw new Error('Unknown community');
 const roles=db.prepare('SELECT id,permissions FROM roles WHERE server_id=?').all(serverId) as {id:string;permissions:number}[];
 const overwrites=db.prepare('SELECT target_id AS targetId,target_type AS targetType,allow,deny FROM overwrites WHERE channel_id=?').all(channelId) as unknown as Overwrite[];
 return (db.prepare('SELECT user_id FROM members WHERE server_id=? ORDER BY user_id').all(serverId) as {user_id:string}[]).filter(({user_id:userId})=>has(computePermissions({ownerId:String(server.owner_id),userId,everyoneRoleId:String(channel.server_id),roles,overwrites,memberRoleIds:(db.prepare('SELECT role_id FROM member_roles WHERE server_id=? AND user_id=?').all(serverId,userId) as {role_id:string}[]).map(r=>r.role_id)}),Permission.VIEW_CHANNEL)).map(r=>r.user_id);
}

/** File bytes are committed separately so a receipt cannot certify a stale or
 * corrupted attachment merely because its SQLite metadata stayed unchanged. */
export async function legacyFileDigest(db:DatabaseSync,channelId:string,uploads:string,maxBytes=Number.MAX_SAFE_INTEGER):Promise<string>{
 const {createReadStream}=await import('node:fs'),{lstat}=await import('node:fs/promises'),{join}=await import('node:path');
 const total=Number(db.prepare('SELECT coalesce(sum(a.size),0) AS n FROM attachments a JOIN messages m ON m.id=a.message_id WHERE m.channel_id=?').get(channelId)!.n);
 if(total>maxBytes)throw new Error('Archive attachment volume exceeds validation limit');
 const root=createHash('sha256');root.update('annoy/legacy/files/v1');
 for(const row of db.prepare('SELECT a.id,a.size FROM attachments a JOIN messages m ON m.id=a.message_id WHERE m.channel_id=? ORDER BY a.id').iterate(channelId)){
  const id=String(row.id);if(!/^[a-f0-9]{32}$/.test(id))throw new Error('Unsupported legacy attachment ID');
  const directory=join(uploads,id),parent=await lstat(directory),path=join(directory,'blob'),before=await lstat(path);
  if(!parent.isDirectory()||parent.isSymbolicLink()||!before.isFile()||before.isSymbolicLink()||before.size!==Number(row.size))throw new Error('Legacy attachment integrity mismatch');
  const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);
  const after=await lstat(path);if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new Error('Legacy attachment changed during validation');
  root.update(JSON.stringify([id,hash.digest('hex'),before.size]));
 }
 return root.digest('hex');
}

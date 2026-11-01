import {sendToChannel} from './events.ts';
import {createHash} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {Permission,hasMessages} from '@distopic/protocol';
import {requireUser} from './auth.ts';
import {all,db,now,one,run,tx} from './db.ts';
import {activeDevice,checkSignature,cryptoInstanceId} from './devices.ts';
import {HttpError,forbidden,notFound} from './errors.ts';
import {requireChannel,requireServer} from './perms.ts';
import {getMessages,getUser,dmRecipientIds} from './repo.ts';
import {parse,type Params} from './validate.ts';

db.exec(`CREATE TABLE IF NOT EXISTS crypto_channels (
 channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
 group_id TEXT NOT NULL UNIQUE, epoch INTEGER NOT NULL, state TEXT NOT NULL,
 members TEXT NOT NULL, history_policy TEXT NOT NULL DEFAULT 'since_join', activated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS crypto_envelopes (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 channel_id TEXT NOT NULL REFERENCES crypto_channels(channel_id) ON DELETE CASCADE,
 device_id TEXT NOT NULL REFERENCES crypto_devices(id), kind TEXT NOT NULL,
 epoch INTEGER NOT NULL, target_device TEXT, wire TEXT NOT NULL, signature TEXT NOT NULL,
 roster TEXT, blob_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, expires_at TEXT
);
CREATE INDEX IF NOT EXISTS crypto_delivery_channel ON crypto_envelopes(channel_id,sequence);
CREATE TABLE IF NOT EXISTS crypto_cancelled_envelopes(
 id TEXT PRIMARY KEY,channel_id TEXT NOT NULL REFERENCES crypto_channels(channel_id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id),device_id TEXT NOT NULL,created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS crypto_no_plaintext_insert BEFORE INSERT ON messages
 WHEN EXISTS(SELECT 1 FROM crypto_channels WHERE channel_id=NEW.channel_id)
 BEGIN SELECT RAISE(ABORT,'e2ee_required'); END;
CREATE TRIGGER IF NOT EXISTS crypto_no_plaintext_update BEFORE UPDATE OF content,channel_id ON messages
 WHEN EXISTS(SELECT 1 FROM crypto_channels WHERE channel_id=NEW.channel_id)
 BEGIN SELECT RAISE(ABORT,'e2ee_required'); END;
CREATE TRIGGER IF NOT EXISTS crypto_device_revoked AFTER UPDATE OF revoked_at ON crypto_devices
 WHEN NEW.revoked_at IS NOT NULL
 BEGIN UPDATE crypto_channels SET state='rekey_required' WHERE EXISTS(SELECT 1 FROM json_each(members) WHERE value=NEW.id); END;
CREATE TRIGGER IF NOT EXISTS crypto_member_removed AFTER DELETE ON members
 BEGIN UPDATE crypto_channels SET state='rekey_required' WHERE channel_id IN(SELECT id FROM channels WHERE server_id=OLD.server_id); END;
CREATE TRIGGER IF NOT EXISTS crypto_member_added AFTER INSERT ON members
 BEGIN UPDATE crypto_channels SET state='rekey_required' WHERE channel_id IN(SELECT id FROM channels WHERE server_id=NEW.server_id); END;
CREATE TRIGGER IF NOT EXISTS crypto_overwrites_changed AFTER INSERT ON overwrites
 BEGIN UPDATE crypto_channels SET state='rekey_required' WHERE channel_id=NEW.channel_id; END;
CREATE TRIGGER IF NOT EXISTS crypto_overwrites_updated AFTER UPDATE ON overwrites
 BEGIN UPDATE crypto_channels SET state='rekey_required' WHERE channel_id=NEW.channel_id; END;
CREATE TRIGGER IF NOT EXISTS crypto_overwrites_removed AFTER DELETE ON overwrites
 BEGIN UPDATE crypto_channels SET state='rekey_required' WHERE channel_id=OLD.channel_id; END;
CREATE TRIGGER IF NOT EXISTS crypto_role_changed AFTER UPDATE OF permissions ON roles
 BEGIN UPDATE crypto_channels SET state='rekey_required' WHERE channel_id IN(SELECT id FROM channels WHERE server_id=NEW.server_id); END;
CREATE TRIGGER IF NOT EXISTS crypto_member_roles_added AFTER INSERT ON member_roles
 BEGIN UPDATE crypto_channels SET state='rekey_required' WHERE channel_id IN(SELECT id FROM channels WHERE server_id=NEW.server_id); END;
CREATE TRIGGER IF NOT EXISTS crypto_member_roles_changed AFTER DELETE ON member_roles
 BEGIN UPDATE crypto_channels SET state='rekey_required' WHERE channel_id IN(SELECT id FROM channels WHERE server_id=OLD.server_id); END;
`);
interface CryptoChannel {channel_id:string;group_id:string;epoch:number;state:string;members:string;history_policy:string;activated_at:string}
export const cryptoChannel=(id:string)=>one<CryptoChannel>('SELECT * FROM crypto_channels WHERE channel_id=?',id);
export function requireLegacyWrite(_id:string):void {throw new HttpError(409,'e2ee_required','Novas mensagens, edições e reações exigem OpenMLS; o conteúdo anterior permanece como histórico legado');}
const key=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const signature=z.string().regex(/^[A-Za-z0-9_-]{86}$/);
const wire=z.string().min(16).max(1400000).regex(/^[A-Za-z0-9+/]+={0,2}$/);
function checkRoster(channelId:string,ids:string[]):void {
 if(new Set(ids).size!==ids.length)throw new HttpError(400,'duplicate_device','Dispositivo duplicado');
 for(const id of ids){const device=activeDevice(id);requireChannel(channelId,device.user_id);}
}
export function deliveryRoutes(app:FastifyInstance):void {
 app.get<Params<'id'>>('/channels/:id/crypto/devices',async req=>{
  const user=requireUser(req);const {channel}=requireChannel(req.params.id,user);
  const candidates=channel.type==='dm'
   ?all<{id:string;user_id:string}>('SELECT d.* FROM crypto_devices d JOIN dm_recipients r ON r.user_id=d.user_id WHERE r.channel_id=? AND d.revoked_at IS NULL LIMIT 257',channel.id)
   :all<{id:string;user_id:string}>('SELECT d.* FROM crypto_devices d JOIN members m ON m.user_id=d.user_id WHERE m.server_id=? AND d.revoked_at IS NULL LIMIT 257',channel.serverId);
  if(candidates.length>256)throw new HttpError(409,'member_limit','Este canal excede o limite atual de 256 dispositivos MLS');
  return candidates.filter(d=>{try{requireChannel(channel.id,d.user_id);return true;}catch{return false;}}).map(d=>({...d,user:getUser(d.user_id)}));
 });
 app.get<Params<'id'>>('/channels/:id/crypto',async req=>{const {channel}=requireChannel(req.params.id,requireUser(req));return {version:1,instanceId:cryptoInstanceId(),type:channel.type,participantIds:channel.type==='dm'?dmRecipientIds(channel.id):[],channel:cryptoChannel(req.params.id)??null};});
 app.post<Params<'id'>>('/channels/:id/crypto/activate',async req=>{
  const user=requireUser(req);const {channel}=requireChannel(req.params.id,user,Permission.SEND_MESSAGES);
  if(!hasMessages(channel.type))throw new HttpError(400,'invalid_channel','Canal não aceita mensagens');
  if(channel.serverId && requireServer(channel.serverId,user).server.ownerId!==user)throw forbidden('Somente proprietário pode ativar o grupo criptográfico');
  const body=parse(z.object({version:z.literal(1),groupId:key,deviceId:key,members:z.array(key).min(1).max(256),signature}).strict(),req.body);
  const device=activeDevice(body.deviceId,user);
  if(body.members.length!==1 || body.members[0]!==device.id)throw forbidden();
  checkRoster(channel.id,body.members);
  const payload=JSON.stringify(['annoy/mls/activate/v1',cryptoInstanceId(),channel.id,body.groupId,body.deviceId,body.members]);
  if(!checkSignature(device.public_key,payload,body.signature))throw forbidden('Assinatura inválida');
  return tx(()=>{
   if(cryptoChannel(channel.id))throw new HttpError(409,'already_e2ee','Canal já ativado; downgrade não permitido');
   run('INSERT INTO crypto_channels(channel_id,group_id,epoch,state,members,activated_at) VALUES(?,?,0,\'active\',?,?)',channel.id,body.groupId,JSON.stringify(body.members),now());
   return cryptoChannel(channel.id);
  });
 });
 app.get<Params<'id'>>('/channels/:id/legacy/messages',async req=>{
  requireChannel(req.params.id,requireUser(req));if(!cryptoChannel(req.params.id))throw notFound('Arquivo legado');
  const q=parse(z.object({before:z.string().max(100).optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}),req.query);
  return {protection:'legacy_plaintext',items:getMessages(req.params.id,q.before??null,q.limit)};
 });
 app.post<Params<'id'>>('/channels/:id/crypto/envelopes',async req=>{
  const user=requireUser(req);const {channel}=requireChannel(req.params.id,user,Permission.SEND_MESSAGES);
  const body=parse(z.object({version:z.literal(1),id:z.uuid(),deviceId:key,kind:z.enum(['application','commit','welcome']),epoch:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),targetDevice:key.nullable(),wire,expiresAt:z.iso.datetime().nullable(),members:z.array(key).min(1).max(256).optional(),blobIds:z.array(z.string().regex(/^[a-f0-9]{32}$/)).max(10).default([]),signature}).strict(),req.body);
  const device=activeDevice(body.deviceId,user);
  if(body.expiresAt && (Date.parse(body.expiresAt)<=Date.now() || Date.parse(body.expiresAt)>Date.now()+30*86400000))throw new HttpError(400,'invalid_expiration','Expiração inválida');
  const state=cryptoChannel(channel.id);if(!state)throw new HttpError(409,'not_e2ee','Ative E2EE antes de publicar envelopes');
  const payload=JSON.stringify(['annoy/mls/envelope/v1',cryptoInstanceId(),channel.id,state.group_id,body.id,body.deviceId,body.kind,body.epoch,body.targetDevice,body.expiresAt,body.members??null,body.blobIds,createHash('sha256').update(body.wire).digest('base64url')]);
  if(!checkSignature(device.public_key,payload,body.signature))throw forbidden('Assinatura inválida');
  return tx(()=>{
   const previous=one<{signature:string;sequence:number}>('SELECT signature,sequence FROM crypto_envelopes WHERE id=?',body.id);
   if(previous){if(previous.signature!==body.signature)throw new HttpError(409,'envelope_collision','ID de envelope reutilizado');return {sequence:previous.sequence,id:body.id};}
   if(one('SELECT 1 FROM crypto_cancelled_envelopes WHERE id=?',body.id))throw new HttpError(409,'delivery_cancelled','Envio cancelado');
   const current=cryptoChannel(channel.id)!;
   if(!(JSON.parse(current.members) as string[]).includes(device.id))throw forbidden('Dispositivo fora do grupo');
   if(body.kind==='commit'){
    if(body.epoch!==current.epoch+1 || !body.members || !body.members.includes(device.id))throw new HttpError(409,'epoch_conflict','Commit deve avançar uma época');
    checkRoster(channel.id,body.members);
    run("UPDATE crypto_channels SET epoch=?,members=?,state='active' WHERE channel_id=?",body.epoch,JSON.stringify(body.members),channel.id);
   }else {
    if(body.epoch!==current.epoch || current.state!=='active')throw new HttpError(409,'rekey_required','Aguarde renovação das chaves');
    checkRoster(channel.id,JSON.parse(current.members) as string[]);
   }
   if(body.kind==='welcome'){
    if(!body.targetDevice || !(JSON.parse(cryptoChannel(channel.id)!.members) as string[]).includes(body.targetDevice))throw forbidden('Destinatário inválido');
   }else if(body.targetDevice!==null)throw new HttpError(400,'invalid_target','Somente Welcome pode ter destinatário');
   if(body.kind!=='application' && body.expiresAt!==null)throw new HttpError(400,'invalid_expiration','Commits não expiram como conteúdo');
   for(const blob of body.blobIds) {
    if(!one('SELECT 1 FROM crypto_blobs WHERE id=? AND channel_id=? AND owner_id=? AND message_id IS NULL',blob,channel.id,user))throw forbidden('Anexo não pertence ao remetente');
    run('UPDATE crypto_blobs SET message_id=?,expires_at=? WHERE id=?',body.id,body.expiresAt,blob);
   }
   run('INSERT INTO crypto_envelopes(id,channel_id,device_id,kind,epoch,target_device,wire,signature,roster,blob_ids,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',body.id,channel.id,device.id,body.kind,body.epoch,body.targetDevice,body.wire,body.signature,body.members?JSON.stringify(body.members):null,JSON.stringify(body.blobIds),now(),body.expiresAt);
   // A metadata-only wake-up: plaintext and file keys never enter the gateway.
   queueMicrotask(()=>sendToChannel(channel,{t:'CRYPTO_DELIVERY',d:{channelId:channel.id}}));
   return {id:body.id,sequence:one<{sequence:number}>('SELECT sequence FROM crypto_envelopes WHERE id=?',body.id)!.sequence};
  });
 });
 app.post<Params<'id'>>('/channels/:id/crypto/cancel',async req=>{
  const user=requireUser(req);requireChannel(req.params.id,user);
  const body=parse(z.object({id:z.uuid(),deviceId:key,signature}).strict(),req.body);
  const device=activeDevice(body.deviceId,user),state=cryptoChannel(req.params.id);if(!state)throw notFound('Grupo');
  if(!checkSignature(device.public_key,JSON.stringify(['annoy/mls/cancel/v1',cryptoInstanceId(),req.params.id,state.group_id,body.id,body.deviceId]),body.signature))throw forbidden('Assinatura inválida');
  return tx(()=>{
   const delivered=one<{device_id:string}>('SELECT device_id FROM crypto_envelopes WHERE id=? AND channel_id=?',body.id,req.params.id);
   if(delivered){if(delivered.device_id!==device.id)throw forbidden();return {delivered:true};}
   const previous=one<{user_id:string}>('SELECT user_id FROM crypto_cancelled_envelopes WHERE id=?',body.id);if(previous&&previous.user_id!==user)throw forbidden();
   run('INSERT OR IGNORE INTO crypto_cancelled_envelopes VALUES(?,?,?,?,?)',body.id,req.params.id,user,device.id,now());
   return {delivered:false};
  });
 });
 app.get<Params<'id'>>('/channels/:id/crypto/envelopes',async req=>{
  const user=requireUser(req);requireChannel(req.params.id,user);
  const q=parse(z.object({deviceId:key,after:z.coerce.number().int().min(0).default(0),limit:z.coerce.number().int().min(1).max(100).default(100)}),req.query);
  activeDevice(q.deviceId,user);
  const state=cryptoChannel(req.params.id);if(!state)throw notFound('Grupo');
  if(!(JSON.parse(state.members) as string[]).includes(q.deviceId))throw forbidden('Dispositivo fora do grupo');
  const items:Record<string,unknown>[]=[],time=now();let size=0;
  for(const row of db.prepare('SELECT * FROM crypto_envelopes WHERE channel_id=? AND sequence>? AND (target_device IS NULL OR target_device=?) AND (expires_at IS NULL OR expires_at>?) ORDER BY sequence LIMIT ?').iterate(req.params.id,q.after,q.deviceId,time,q.limit)){
   size+=String(row.wire).length;if(size>4*1024*1024&&items.length)break;items.push(row);
  }
  const after=items.at(-1)?.sequence??q.after;
  const hasMore=!!one('SELECT 1 FROM crypto_envelopes WHERE channel_id=? AND sequence>? AND (target_device IS NULL OR target_device=?) AND (expires_at IS NULL OR expires_at>?) LIMIT 1',req.params.id,after as number,q.deviceId,time);
  return {state,items,hasMore};
 });
 app.put<Params<'id'>>('/channels/:id/crypto/history-policy',async req=>{
  const user=requireUser(req);const {channel}=requireChannel(req.params.id,user);
  if(!channel.serverId || !one('SELECT 1 FROM servers WHERE id=? AND owner_id=?',channel.serverId,user))throw forbidden('Somente proprietário configura histórico');
  const {policy}=parse(z.object({policy:z.enum(['since_join','share_permanent'])}).strict(),req.body);
  if(!cryptoChannel(channel.id))throw notFound('Grupo');
  run('UPDATE crypto_channels SET history_policy=? WHERE channel_id=?',policy,channel.id);return {policy};
 });
}

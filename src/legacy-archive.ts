import {config} from './config.ts';
import {join} from 'node:path';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {db,now,run} from './db.ts';
import {requireUser} from './auth.ts';
import {requireChannel} from './perms.ts';
import {activeDevice,checkSignature,cryptoInstanceId} from './devices.ts';
import {parse,type Params} from './validate.ts';
import {legacyManifest,legacyFileDigest} from './legacy-manifest.ts';
import {HttpError,forbidden} from './errors.ts';
db.exec(`CREATE TABLE IF NOT EXISTS legacy_archive_receipts(
 channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),
 device_id TEXT NOT NULL REFERENCES crypto_devices(id),fingerprint TEXT NOT NULL,file_digest TEXT NOT NULL,messages INTEGER NOT NULL,attachments INTEGER NOT NULL,
 signature TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(channel_id,user_id)
);`);
if(!(db.prepare('PRAGMA table_info(legacy_archive_receipts)').all() as {name:string}[]).some(c=>c.name==='file_digest'))db.exec('ALTER TABLE legacy_archive_receipts ADD COLUMN file_digest TEXT');
export function legacyArchiveRoutes(app:FastifyInstance):void {
 let activeValidations=0;
 const limits=new Map<string,{at:number;count:number}>();
 const limit=(user:string)=>{const now=Date.now();for(const [id,b]of limits)if(now-b.at>=60000)limits.delete(id);let b=limits.get(user);if(!b){if(limits.size>=10000)throw new HttpError(429,'archive_busy','Tente novamente');b={at:now,count:0};limits.set(user,b);}if(++b.count>5)throw new HttpError(429,'archive_rate_limit','Aguarde um minuto antes de validar novamente');};
 app.get<Params<'id'>>('/channels/:id/legacy/manifest',async req=>{
  const user=requireUser(req);requireChannel(req.params.id,user);limit(user);
  const count=Number(db.prepare('SELECT count(*) AS n FROM messages WHERE channel_id=?').get(req.params.id)!.n);
  if(count>100000)throw new HttpError(413,'archive_limit','Migração assistida atual limitada a 100 mil mensagens por canal; mantenha a origem e planeje exportação em lotes');
  return legacyManifest(db,req.params.id);
 });
 app.post<Params<'id'>>('/channels/:id/legacy/receipt',async req=>{
  const user=requireUser(req);requireChannel(req.params.id,user);limit(user);
  const body=parse(z.object({version:z.literal(1),deviceId:z.string().regex(/^[A-Za-z0-9_-]{43}$/),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),messages:z.number().int().min(0).max(100000),attachments:z.number().int().min(0).max(1000000),fileDigest:z.string().regex(/^[a-f0-9]{64}$/),signature:z.string().regex(/^[A-Za-z0-9_-]{86}$/)}).strict(),req.body);
  const device=activeDevice(body.deviceId,user),manifest=legacyManifest(db,req.params.id);
  if(manifest.fingerprint!==body.fingerprint||manifest.messages!==body.messages||manifest.attachments!==body.attachments)throw new HttpError(409,'archive_changed','Histórico legado mudou; valide a cópia novamente');
  if(!checkSignature(device.public_key,JSON.stringify(['annoy/legacy/archive/v1',cryptoInstanceId(),user,req.params.id,body.deviceId,body.fingerprint,body.fileDigest,body.messages,body.attachments]),body.signature))throw forbidden('Assinatura de arquivo inválida');
  if(activeValidations>=2)throw new HttpError(429,'archive_busy','Validação ocupada; tente novamente');
  let files:string;activeValidations++;try{files=await legacyFileDigest(db,req.params.id,join(config.dataDir,'uploads'),2*1024*1024*1024);}catch{throw new HttpError(409,'archive_files_unverified','Arquivos de origem não foram validados; mantenha a origem e revise o plano de migração');}finally{activeValidations--;}
  // Recheck authorization after asynchronous I/O, before accepting a receipt.
  requireUser(req);requireChannel(req.params.id,user);activeDevice(body.deviceId,user);
  if(files!==body.fileDigest||legacyManifest(db,req.params.id).fingerprint!==manifest.fingerprint)throw new HttpError(409,'archive_changed','Conteúdo de origem mudou durante a validação');
  run('INSERT INTO legacy_archive_receipts(channel_id,user_id,device_id,fingerprint,file_digest,messages,attachments,signature,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(channel_id,user_id) DO UPDATE SET device_id=excluded.device_id,fingerprint=excluded.fingerprint,file_digest=excluded.file_digest,messages=excluded.messages,attachments=excluded.attachments,signature=excluded.signature,created_at=excluded.created_at',req.params.id,user,device.id,body.fingerprint,body.fileDigest,body.messages,body.attachments,body.signature,now());
  return {archived:true,source:'legacy_plaintext',destructive:false};
 });
 app.addHook('onClose',async()=>{limits.clear();});
}

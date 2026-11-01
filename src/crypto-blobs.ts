import type {FastifyInstance} from 'fastify';
import {Readable} from 'node:stream';
import {z} from 'zod';
import {Permission} from '@distopic/protocol';
import {requireUser} from './auth.ts';
import {activeDevice} from './devices.ts';
import {db,one,run,all,now,tx} from './db.ts';
import {requireChannel} from './perms.ts';
import {cryptoChannel} from './crypto-delivery.ts';
import {readBlob,writeBlob,discardBlobs} from './uploads.ts';
import {maxUploadBytes} from './instance.ts';
import {HttpError,notFound} from './errors.ts';
import {parse,type Params} from './validate.ts';
export const MAX_CRYPTO_FILE=64*1024*1024;
db.exec(`CREATE TABLE IF NOT EXISTS crypto_blobs (
 id TEXT PRIMARY KEY,channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
 owner_id TEXT NOT NULL REFERENCES users(id),size INTEGER NOT NULL,created_at TEXT NOT NULL,
 message_id TEXT,expires_at TEXT
);
CREATE TABLE IF NOT EXISTS crypto_blob_gc(id TEXT PRIMARY KEY);
CREATE TRIGGER IF NOT EXISTS crypto_blob_deleted AFTER DELETE ON crypto_blobs
 BEGIN INSERT OR IGNORE INTO crypto_blob_gc(id) VALUES(OLD.id); END;`);
export function cryptoBlobRoutes(app:FastifyInstance):void {
 app.addContentTypeParser('application/octet-stream',{parseAs:'buffer'},(req,body,done)=>done(null,body));
 app.post<Params<'channel'|'id'>>('/channels/:channel/crypto/blobs/:id',{bodyLimit:MAX_CRYPTO_FILE+29},async req=>{
  const user=requireUser(req);requireChannel(req.params.channel,user,Permission.ATTACH_FILES);
  if(!cryptoChannel(req.params.channel))throw new HttpError(409,'e2ee_required','Ative MLS antes de enviar anexos');
  const id=parse(z.string().regex(/^[a-f0-9]{32}$/),req.params.id);
  const device=parse(z.string().regex(/^[A-Za-z0-9_-]{43}$/),req.headers['annoy-device']);activeDevice(device,user);
  const bytes=req.body as Buffer;
  if(!Buffer.isBuffer(bytes) || bytes.length<29 || bytes.length>Math.min(MAX_CRYPTO_FILE,maxUploadBytes())+29)throw new HttpError(413,'file_limit','Anexo cifrado excede o limite permitido');
  tx(()=>{
   const quota=one<{size:number}>('SELECT coalesce(sum(size),0) AS size FROM crypto_blobs WHERE owner_id=?',user)!.size;
   if(quota+bytes.length>1024*1024*1024)throw new HttpError(507,'storage_limit','Limite de armazenamento cifrado da conta atingido');
   if(one('SELECT 1 FROM crypto_blobs WHERE id=?',id)||one('SELECT 1 FROM attachments WHERE id=?',id))throw new HttpError(409,'blob_exists','ID de arquivo já utilizado');
   run('INSERT INTO crypto_blobs(id,channel_id,owner_id,size,created_at,expires_at) VALUES(?,?,?,?,?,?)',id,req.params.channel,user,bytes.length,now(),new Date(Date.now()+86400000).toISOString());
  });
  try {await writeBlob(id,Readable.from([bytes]));}
  catch(error){run('DELETE FROM crypto_blobs WHERE id=?',id);throw error;}
  return {id,size:bytes.length};
 });
 app.get<Params<'channel'|'id'>>('/channels/:channel/crypto/blobs/:id',async(req,reply)=>{
  requireChannel(req.params.channel,requireUser(req));const row=one<{size:number}>('SELECT size FROM crypto_blobs WHERE id=? AND channel_id=? AND message_id IS NOT NULL AND (expires_at IS NULL OR expires_at>?)',req.params.id,req.params.channel,now());
  if(!row || !/^[a-f0-9]{32}$/.test(req.params.id))throw notFound('Anexo');
  reply.header('Content-Type','application/octet-stream').header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff').header('Content-Length',row.size);
  return reply.send(readBlob(req.params.id));
 });
}

export function startCryptoCleanup(app:FastifyInstance):void {
 let inFlight:Promise<void>|null=null,closing=false;
 const clean=()=>{
  if(inFlight||closing)return;
  inFlight=(async()=>{
   try {
    run('DELETE FROM crypto_blobs WHERE id IN(SELECT id FROM crypto_blobs WHERE expires_at IS NOT NULL AND expires_at<=? LIMIT 100)',now());
    for(const row of all<{id:string}>('SELECT id FROM crypto_blob_gc LIMIT 100')){
     await discardBlobs([row.id]);run('DELETE FROM crypto_blob_gc WHERE id=?',row.id);
    }
    run('DELETE FROM crypto_envelopes WHERE expires_at IS NOT NULL AND expires_at<=?',now());
   }catch{app.log.warn({code:'crypto_cleanup_failed'},'Encrypted content cleanup pending');}
   finally{inFlight=null;}
  })();
 };
 const timer=setInterval(clean,30000);timer.unref();clean();
 app.addHook('onClose',async()=>{closing=true;clearInterval(timer);await inFlight;});
}

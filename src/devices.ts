import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { bearerToken, hashToken, requireUser } from './auth.ts';
import { all, one, run, tx, now, db } from './db.ts';
import { HttpError, forbidden, notFound } from './errors.ts';
import { parse } from './validate.ts';
import { disconnectEverywhere } from './accounts.ts';

// Public material only. Device signing keys are distinct from MLS leaf keys.
db.exec(`CREATE TABLE IF NOT EXISTS crypto_devices (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), public_key TEXT NOT NULL,
 recovery_key TEXT NOT NULL, mls_key TEXT NOT NULL, enrollment_nonce TEXT NOT NULL, self_signature TEXT NOT NULL, approved_by TEXT, endorsement TEXT, created_at TEXT NOT NULL, revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS crypto_devices_user ON crypto_devices(user_id);
CREATE TABLE IF NOT EXISTS device_challenges (
 hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_hash TEXT NOT NULL, purpose TEXT NOT NULL,
 expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS device_key_packages (
 id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES crypto_devices(id), package TEXT NOT NULL,
 signature TEXT NOT NULL, nonce TEXT NOT NULL, created_at TEXT NOT NULL, claimed_by TEXT
);
CREATE INDEX IF NOT EXISTS device_key_packages_created ON device_key_packages(created_at);`);
const expirePackages=()=>run("DELETE FROM device_key_packages WHERE created_at<?",new Date(Date.now()-7*86400000).toISOString());
if(!one("SELECT 1 FROM instance_settings WHERE key='crypto.instanceId'")) run("INSERT INTO instance_settings(key,value) VALUES('crypto.instanceId',?)",randomBytes(32).toString('base64url'));
export const cryptoInstanceId=()=>one<{value:string}>("SELECT value FROM instance_settings WHERE key='crypto.instanceId'")!.value;
const key = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const signature = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
const deviceId = (pub:string) => createHash('sha256').update(Buffer.from(pub,'base64url')).digest('base64url');
export function checkSignature(pub:string,payload:string,sig:string):boolean {
 try {
  if(Buffer.from(pub,'base64url').toString('base64url')!==pub || Buffer.from(sig,'base64url').toString('base64url')!==sig) return false;
  return verify(null,Buffer.from(payload),createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:pub},format:'jwk'}),Buffer.from(sig,'base64url')); }
 catch {return false;}
}
export function activeDevice(id:string,userId?:string) {
 const device=one<{id:string;user_id:string;public_key:string;recovery_key:string;revoked_at:string|null}>('SELECT * FROM crypto_devices WHERE id=? AND revoked_at IS NULL',id);
 if(!device || (userId && device.user_id!==userId)) throw forbidden('Dispositivo não autorizado');
 return device;
}
function challenge(req:Parameters<typeof requireUser>[0],purpose:string,nonce:string) {
 const user=requireUser(req);
 const row=one('SELECT 1 FROM device_challenges WHERE hash=? AND user_id=? AND session_hash=? AND purpose=? AND expires_at>?',hashToken(nonce),user,hashToken(bearerToken(req)!),purpose,now());
 if(!row) throw new HttpError(401,'invalid_challenge','Desafio expirado ou utilizado');
 run('DELETE FROM device_challenges WHERE hash=?',hashToken(nonce));
 return user;
}
export function deviceRoutes(app:FastifyInstance) {
 app.get<{Params:{deviceId:string}}>('/crypto/devices/:deviceId',async req=>{
  requireUser(req);
  const id=parse(key,req.params.deviceId);
  const row=one('SELECT id,user_id,public_key,recovery_key,mls_key,enrollment_nonce,self_signature,approved_by,endorsement,created_at,revoked_at FROM crypto_devices WHERE id=?',id);
  if(!row)throw notFound('Dispositivo');return row;
 });
 app.post('/crypto/devices/challenge',async req=>{
  const user=requireUser(req);const {purpose}=parse(z.object({purpose:z.enum(['enroll','revoke','package','bind'])}).strict(),req.body);
  return tx(()=>{
   run('DELETE FROM device_challenges WHERE expires_at<=?',now());
   if((one<{n:number}>('SELECT count(*) AS n FROM device_challenges WHERE user_id=?',user)?.n??0)>=8) throw new HttpError(429,'device_rate_limit','Muitos desafios pendentes');
   const nonce=randomBytes(32).toString('base64url');
   run('INSERT INTO device_challenges VALUES(?,?,?,?,?)',hashToken(nonce),user,hashToken(bearerToken(req)!),purpose,new Date(Date.now()+120000).toISOString());
   return {nonce,expiresIn:120,instanceId:cryptoInstanceId()};
  });
 });
 app.get<{Params:{userId:string}}>('/crypto/users/:userId/devices',async req=>{
  requireUser(req);
  if(!one('SELECT 1 FROM users WHERE id=?',req.params.userId)) throw notFound('Usuário');
  return all('SELECT id,user_id,public_key,recovery_key,mls_key,enrollment_nonce,self_signature,approved_by,endorsement,created_at,revoked_at FROM crypto_devices WHERE user_id=? ORDER BY created_at,id',req.params.userId);
 });
 app.post('/crypto/devices',async req=>{
  const body=parse(z.object({nonce:key,publicKey:key,recoveryKey:key,mlsKey:key,signature,approver:key.optional(),endorsement:signature.optional()}).strict(),req.body);
  const user=requireUser(req);const id=deviceId(body.publicKey);
  const payload=JSON.stringify(['annoy/device/enroll/v1',cryptoInstanceId(),user,id,body.publicKey,body.recoveryKey,body.mlsKey,body.nonce]);
  if(!checkSignature(body.publicKey,payload,body.signature)) throw new HttpError(401,'invalid_signature','Assinatura inválida');
  return tx(()=>{
   challenge(req,'enroll',body.nonce);
   if(one('SELECT 1 FROM crypto_devices WHERE id=?',id)) throw new HttpError(409,'device_exists','Dispositivo já registrado');
   const existing=one<{recovery_key:string}>('SELECT recovery_key FROM crypto_devices WHERE user_id=? LIMIT 1',user);
   if(existing) {
    if(existing.recovery_key!==body.recoveryKey || !body.endorsement) throw forbidden('Aprovação de dispositivo confiável ou chave de recuperação é necessária');
    const pub=body.approver ? activeDevice(body.approver,user).public_key : existing.recovery_key;
    if(!checkSignature(pub,payload,body.endorsement)) throw forbidden('Aprovação inválida');
   }
   if((one<{n:number}>('SELECT count(*) AS n FROM crypto_devices WHERE user_id=? AND revoked_at IS NULL',user)?.n??0)>=16) throw new HttpError(429,'device_limit','Limite de dispositivos');
   run('INSERT INTO crypto_devices(id,user_id,public_key,recovery_key,mls_key,enrollment_nonce,self_signature,approved_by,endorsement,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',id,user,body.publicKey,body.recoveryKey,body.mlsKey,body.nonce,body.signature,body.approver??null,body.endorsement??null,now());
   return {id,publicKey:body.publicKey};
  });
 });
 app.post<{Params:{id:string}}>('/crypto/devices/:id/revoke',async req=>{
  const user=requireUser(req);
  const body=parse(z.object({nonce:key,approver:key.optional(),signature}).strict(),req.body);
  const target=activeDevice(req.params.id,user);
  const pub=body.approver?activeDevice(body.approver,user).public_key:target.recovery_key;
  const payload=JSON.stringify(['annoy/device/revoke/v1',cryptoInstanceId(),user,target.id,body.nonce]);
  if(!checkSignature(pub,payload,body.signature)) throw forbidden('Aprovação inválida');
  tx(()=>{
   challenge(req,'revoke',body.nonce);
   run('UPDATE crypto_devices SET revoked_at=? WHERE id=?',now(),target.id);
   run('DELETE FROM device_key_packages WHERE device_id=?',target.id);
  });
  // Until sessions are bound to devices, revoke all sessions, not an unsafe subset.
  disconnectEverywhere(user,'Dispositivo revogado; autentique novamente');
  return {revoked:true,requiresGroupRekey:true};
 });
 app.get('/crypto/key-packages/count',async req=>{
  expirePackages();
  const user=requireUser(req),body=parse(z.object({deviceId:key}),req.query);activeDevice(body.deviceId,user);
  return {available:one<{n:number}>('SELECT count(*) AS n FROM device_key_packages WHERE device_id=? AND claimed_by IS NULL',body.deviceId)!.n};
 });
 app.post('/crypto/key-packages',async req=>{
  expirePackages();
  const user=requireUser(req);
  const body=parse(z.object({nonce:key,deviceId:key,package:z.string().min(1).max(32768),signature}).strict(),req.body);
  const device=activeDevice(body.deviceId,user);
  const digest=createHash('sha256').update(body.package).digest('base64url');
  if(!checkSignature(device.public_key,JSON.stringify(['annoy/key-package/v1',cryptoInstanceId(),user,device.id,digest,body.nonce]),body.signature)) throw forbidden('Assinatura inválida');
  tx(()=>{
   challenge(req,'package',body.nonce);
   if((one<{n:number}>('SELECT count(*) AS n FROM device_key_packages WHERE device_id=? AND claimed_by IS NULL',device.id)?.n??0)>=50) throw new HttpError(429,'package_limit','Limite de KeyPackages');
   run('INSERT INTO device_key_packages(id,device_id,package,signature,nonce,created_at) VALUES(?,?,?,?,?,?)',digest,device.id,body.package,body.signature,body.nonce,now());
  });
  return {id:digest};
 });
 app.post<{Params:{deviceId:string}}>('/crypto/key-packages/:deviceId/claim',async req=>{
  expirePackages();
  const user=requireUser(req);activeDevice(req.params.deviceId);
  // Only friends or users sharing an instance community may claim packages.
  const target=activeDevice(req.params.deviceId).user_id;
  if(user!==target && !one("SELECT 1 FROM relationships WHERE user_id=? AND other_id=? AND status='friend'",user,target) &&
   !one('SELECT 1 FROM members a JOIN members b ON a.server_id=b.server_id WHERE a.user_id=? AND b.user_id=?',user,target) && !one('SELECT 1 FROM dm_recipients a JOIN dm_recipients b ON a.channel_id=b.channel_id WHERE a.user_id=? AND b.user_id=?',user,target)) throw forbidden();
  return tx(()=>{
   const row=one<{id:string;package:string;signature:string;nonce:string}>('SELECT id,package,signature,nonce FROM device_key_packages WHERE device_id=? AND claimed_by IS NULL ORDER BY created_at,id LIMIT 1',req.params.deviceId);
   if(!row) throw new HttpError(409,'no_key_package','Dispositivo sem KeyPackage disponível');
   run('UPDATE device_key_packages SET claimed_by=? WHERE id=?',user,row.id);
   return row;
  });
 });
}

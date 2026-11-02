// RFC 9449 proof-of-possession. JOSE validation is delegated to jose.
import {createHash,randomBytes} from 'node:crypto';
import {decodeProtectedHeader,importJWK,jwtVerify} from 'jose';
import type {FastifyRequest,FastifyReply} from 'fastify';
import {db,one,run,now,tx} from './db.ts';
import {config} from './config.ts';
import {HttpError} from './errors.ts';

if(!(db.prepare('PRAGMA table_info(sessions)').all() as {name:string}[]).some(c=>c.name==='device_id'))db.exec('ALTER TABLE sessions ADD COLUMN device_id TEXT');
db.exec('CREATE TABLE IF NOT EXISTS dpop_replay (id TEXT PRIMARY KEY,expires_at TEXT NOT NULL)');
export const dpopNonce=randomBytes(32).toString('base64url');
const verified=new WeakSet<FastifyRequest>();
const hash=(value:string)=>createHash('sha256').update(value).digest('base64url');
const tokenHash=(value:string)=>createHash('sha256').update(value).digest('hex');
export const boundDevice=(token:string)=>one<{device_id:string|null}>('SELECT device_id FROM sessions WHERE token_hash=?',tokenHash(token))?.device_id??null;
export const hasVerifiedProof=(req:FastifyRequest)=>verified.has(req);
export async function verifyDpop(token:string,proof:unknown,method:string,uri:string,deviceId:string):Promise<void>{
 if(typeof proof!=='string'||proof.length>8192)throw new HttpError(401,'dpop_required','Comprove a posse da chave do dispositivo');
 const device=one<{public_key:string}>('SELECT public_key FROM crypto_devices WHERE id=? AND revoked_at IS NULL',deviceId);
 if(!device)throw new HttpError(401,'device_revoked','Dispositivo revogado');
 try{
  const header=decodeProtectedHeader(proof);
  if(header.typ!=='dpop+jwt'||header.alg!=='EdDSA'||header.jwk?.kty!=='OKP'||header.jwk.crv!=='Ed25519'||header.jwk.x!==device.public_key||'d' in header.jwk)throw new Error();
  const publicKey=await importJWK({kty:'OKP',crv:'Ed25519',x:device.public_key},'EdDSA');
  const {payload}=await jwtVerify(proof,publicKey,{algorithms:['EdDSA'],typ:'dpop+jwt',requiredClaims:['iat','jti','htm','htu','ath','nonce'],maxTokenAge:'60s',clockTolerance:5});
  const target=new URL(uri);target.search='';target.hash='';
  const reason=payload.htm!==method.toUpperCase()?'htm':payload.htu!==target.toString()?'htu':payload.ath!==hash(token)?'ath':payload.nonce!==dpopNonce?'nonce':typeof payload.jti!=='string'||payload.jti.length<16||payload.jti.length>100?'jti':'';
  // Diagnostics only: which claim failed (no secrets: htu and target are public URLs).
  if(reason){console.error(`invalid_dpop ${reason} htu=${String(payload.htu)} target=${target}`);throw new Error();}
  tx(()=>{
   run('DELETE FROM dpop_replay WHERE expires_at<=?',now());
   const id=hash(tokenHash(token)+':'+payload.jti);
   if(one('SELECT 1 FROM dpop_replay WHERE id=?',id))throw new Error();
   run('INSERT INTO dpop_replay VALUES(?,?)',id,new Date(Date.now()+120000).toISOString());
   renewBoundSession(token,deviceId);
  });
 }catch(e){if(e instanceof Error&&e.message)console.error('invalid_dpop',e.message);throw new HttpError(401,'invalid_dpop','Prova de dispositivo inválida ou repetida');}
}
export async function validateDpopRequest(req:FastifyRequest,reply:FastifyReply):Promise<void>{
 reply.header('DPoP-Nonce',dpopNonce);
 const auth=req.headers.authorization,token=auth?.match(/^(?:Bearer|DPoP) (.+)$/)?.[1];if(!token)return;
 const device=boundDevice(token);if(!device)return;
 if(!auth?.startsWith('DPoP '))throw new HttpError(401,'dpop_required','Sessão vinculada ao dispositivo exige DPoP');
 const origin=config.publicUrl||`${req.protocol}://${req.host}`;
 await verifyDpop(token,req.headers.dpop,req.method,new URL(req.url,origin).toString(),device);
 verified.add(req);
}

/** A device-bound session in use stays valid: each proven request extends it by up to a day,
 * never beyond 30 days after sign-in. Unused sessions still expire after 24 hours. */
const SESSION_RENEWAL_MS=24*3600000,SESSION_MAX_MS=30*24*3600000;
function renewBoundSession(token:string,deviceId:string):void{
 const session=one<{created_at:string;expires_at:string}>('SELECT created_at,expires_at FROM sessions WHERE token_hash=? AND device_id=?',tokenHash(token),deviceId);
 if(!session)return;
 const next=Math.min(Date.now()+SESSION_RENEWAL_MS,Date.parse(session.created_at)+SESSION_MAX_MS);
 // Write at most once an hour per session.
 if(next-Date.parse(session.expires_at)>3600000)run('UPDATE sessions SET expires_at=? WHERE token_hash=? AND device_id=?',new Date(next).toISOString(),tokenHash(token),deviceId);
}

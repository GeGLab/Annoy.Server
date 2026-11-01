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
  if(payload.htm!==method.toUpperCase()||payload.htu!==target.toString()||payload.ath!==hash(token)||payload.nonce!==dpopNonce||typeof payload.jti!=='string'||payload.jti.length<16||payload.jti.length>100)throw new Error();
  tx(()=>{
   run('DELETE FROM dpop_replay WHERE expires_at<=?',now());
   const id=hash(tokenHash(token)+':'+payload.jti);
   if(one('SELECT 1 FROM dpop_replay WHERE id=?',id))throw new Error();
   run('INSERT INTO dpop_replay VALUES(?,?)',id,new Date(Date.now()+120000).toISOString());
  });
 }catch{throw new HttpError(401,'invalid_dpop','Prova de dispositivo inválida ou repetida');}
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

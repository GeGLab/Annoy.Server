import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';

test('device enrollment requires possession and trusted approval; revocation is final and invalidates sessions',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'annoy-devices-'));
 process.env.ANNOY_DATA_DIR=dir;process.env.ANNOY_ACCOUNT_MODE='local';delete process.env.ANNOY_GLOBAL;
 const {db,run}=await import('../src/db.ts');
 const {createSession,userIdForToken}=await import('../src/auth.ts');
 const {deviceRoutes}=await import('../src/devices.ts');
 const {HttpError}=await import('../src/errors.ts');
 const app=Fastify();app.setErrorHandler((e,req,reply)=>reply.status(e instanceof HttpError?e.status:500).send({error:e.code}));deviceRoutes(app);
 const key=()=>{const k=generateKeyPairSync('ed25519');const pub=k.publicKey.export({format:'jwk'}).x!;return {...k,pub,id:createHash('sha256').update(Buffer.from(pub,'base64url')).digest('base64url')};};
 const root=key(),a=key(),b=key(),attacker=key();
 const signature=(k:ReturnType<typeof key>,p:unknown)=>sign(null,Buffer.from(JSON.stringify(p)),k.privateKey).toString('base64url');
 try {
  run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES('u','alice','Alice','!','2026-01-01')");
  let token=createSession('u');
  const call=(path:string,body:unknown)=>app.inject({method:'POST',url:path,payload:body,headers:{authorization:'Bearer '+token}});
  const challenge=async(purpose:string)=>(await call('/crypto/devices/challenge',{purpose})).json();
  const enroll=async(device:ReturnType<typeof key>,approver?:ReturnType<typeof key>)=>{
   const {nonce,instanceId}=await challenge('enroll');
   const payload=['annoy/device/enroll/v1',instanceId,'u',device.id,device.pub,root.pub,device.pub,nonce];
   return {body:{nonce,publicKey:device.pub,recoveryKey:root.pub,mlsKey:device.pub,signature:signature(device,payload),...(approver?{approver:approver.id,endorsement:signature(approver,payload)}:{})},payload};
  };
  let entry=await enroll(a);
  const forged=await call('/crypto/devices',{...entry.body,signature:signature(attacker,entry.payload)});assert.equal(forged.statusCode,401);
  assert.equal((await call('/crypto/devices',entry.body)).statusCode,200);
  assert.equal((await call('/crypto/devices',entry.body)).statusCode,401,'challenge cannot replay');
  entry=await enroll(b);assert.equal((await call('/crypto/devices',entry.body)).statusCode,403,'stolen session cannot add device');
  entry=await enroll(b,a);assert.equal((await call('/crypto/devices',entry.body)).statusCode,200);
  const {nonce,instanceId}=await challenge('revoke');
  assert.equal((await call('/crypto/devices/'+b.id+'/revoke',{nonce,approver:a.id,signature:signature(a,['annoy/device/revoke/v1',instanceId,'u',b.id,nonce])})).statusCode,200);
  assert.equal(userIdForToken(token),null);
  token=createSession('u');
  const next=await enroll(attacker,b);assert.equal((await call('/crypto/devices',next.body)).statusCode,403,'revoked device cannot authorize');
 } finally {await app.close();db.close();await rm(dir,{recursive:true,force:true});}
});

import {clientModule} from './fixtures/client-root.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import Fastify from 'fastify';

test('DPoP binds sessions to device, method, URI and token; proofs cannot replay after database restore/restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'annoy-dpop-'));process.env.ANNOY_DATA_DIR=dir;process.env.ANNOY_ACCOUNT_MODE='local';delete process.env.ANNOY_GLOBAL;
 const {db,run}=await import('../src/db.ts');const {authRoutes}=await import('../src/routes/auth.ts');const {createSession,requireUser}=await import('../src/auth.ts');const {dpopNonce}=await import('../src/dpop.ts');const {HttpError}=await import('../src/errors.ts');
 const {deviceProof}=await import(clientModule('src/main/crypto/dpop.ts'));
 const app=Fastify();app.setErrorHandler((e,req,reply)=>reply.status(e instanceof HttpError?e.status:500).send({error:e.code}));authRoutes(app);app.get('/protected',async req=>({user:requireUser(req)}));
 const pair=generateKeyPairSync('ed25519'),pub=pair.publicKey.export({format:'jwk'}).x!,privateKey=pair.privateKey.export({format:'der',type:'pkcs8'}).toString('base64'),id=createHash('sha256').update(Buffer.from(pub,'base64url')).digest('base64url');
 const origin='http://127.0.0.1:48102';
 try{
  run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES('u','alice','Alice','!','2026-01-01')");
  run("INSERT INTO crypto_devices(id,user_id,public_key,recovery_key,mls_key,enrollment_nonce,self_signature,created_at) VALUES(?,'u',?,?,?,?,?,'2026-01-01')",id,pub,pub,pub,'nonce','signature');
  const token=createSession('u');
  const bindingProof=await deviceProof(pub,privateKey,token,'POST',origin+'/auth/device-bind',dpopNonce);
  assert.equal((await app.inject({method:'POST',url:'/auth/device-bind',headers:{host:'127.0.0.1:48102',authorization:'Bearer '+token},payload:{deviceId:id,proof:bindingProof}})).statusCode,200);
  const request=(proof?:string)=>app.inject({method:'GET',url:'/protected',headers:{host:'127.0.0.1:48102',authorization:(proof?'DPoP ':'Bearer ')+token,...(proof?{dpop:proof}:{})}});
  assert.equal((await request()).statusCode,401);
  const proof=await deviceProof(pub,privateKey,token,'GET',origin+'/protected',dpopNonce);
  assert.equal((await request(proof)).statusCode,200);assert.equal((await request(proof)).statusCode,401);
  assert.equal((await request(await deviceProof(pub,privateKey,token,'POST',origin+'/protected',dpopNonce))).statusCode,401);
  assert.equal((await request(await deviceProof(pub,privateKey,'different-token','GET',origin+'/protected',dpopNonce))).statusCode,401);
  assert.equal((await request(await deviceProof(pub,privateKey,token,'GET',origin+'/different',dpopNonce))).statusCode,401);
  const unused=await deviceProof(pub,privateKey,token,'GET',origin+'/protected',dpopNonce);
  run('DELETE FROM dpop_replay');
  const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',`
   import assert from 'node:assert/strict';
   const {verifyDpop}=await import('./src/dpop.ts');
   await assert.rejects(verifyDpop(process.env.TEST_TOKEN,process.env.TEST_PROOF,'GET','${origin}/protected',process.env.TEST_DEVICE));
   const {db}=await import('./src/db.ts');db.close();
  `],{env:{...process.env,TEST_TOKEN:token,TEST_PROOF:unused,TEST_DEVICE:id},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  run('UPDATE crypto_devices SET revoked_at=? WHERE id=?',new Date().toISOString(),id);
  assert.equal((await request(await deviceProof(pub,privateKey,token,'GET',origin+'/protected',dpopNonce))).statusCode,401);
 }finally{await app.close();db.close();await rm(dir,{recursive:true,force:true});}
});

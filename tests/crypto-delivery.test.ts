import {clientModule,cryptoBinary} from './fixtures/client-root.ts';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {existsSync} from 'node:fs';
import Fastify from 'fastify';
const binary=cryptoBinary;

if(process.env.ANNOY_REQUIRE_NATIVE==='1'&&!existsSync(binary))throw new Error('Native OpenMLS binary missing; security validation cannot skip this test');
test('real MLS clients deliver opaque messages; activation prevents plaintext through routes and SQLite', {skip:!existsSync(binary)},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'annoy-delivery-'));
 process.env.ANNOY_DATA_DIR=join(dir,'server');process.env.ANNOY_ACCOUNT_MODE='local';delete process.env.ANNOY_GLOBAL;
 const {db,run,all}=await import('../src/db.ts');
 db.function("annoy_legacy_source_write",()=>1); // Historical fixture connection only.
 const {createSession}=await import('../src/auth.ts');
 const {cryptoInstanceId,deviceRoutes}=await import('../src/devices.ts');
 const {deliveryRoutes}=await import('../src/crypto-delivery.ts');
 const {channelRoutes}=await import('../src/routes/channels.ts');
 const {HttpError}=await import('../src/errors.ts');
 const {EncryptedVault,seal,open}=await import(clientModule('src/main/crypto/vault.ts'));
 const {MlsService}=await import(clientModule('src/main/crypto/mls-service.ts'));
 const app=Fastify();app.setErrorHandler((e,req,reply)=>reply.status(e instanceof HttpError?e.status:500).send({error:e.code,message:e.message}));
 deviceRoutes(app);deliveryRoutes(app);channelRoutes(app);
 const os=randomBytes(32);const vault=new EncryptedVault(join(dir,'client'),{available:()=>true,seal:b=>seal(os,b,'os'),open:b=>open(os,b,'os')});await vault.unlock();
 const key=()=>{const k=generateKeyPairSync('ed25519');const pub=k.publicKey.export({format:'jwk'}).x!;return {...k,pub,id:createHash('sha256').update(Buffer.from(pub,'base64url')).digest('base64url')};};
 const a=key(),b=key(),recovery=key();const instance=cryptoInstanceId();
 const ai=JSON.stringify([instance,'alice',a.id]),bi=JSON.stringify([instance,'bob',b.id]);
 const alice=new MlsService(binary,vault,ai,'alice'),bob=new MlsService(binary,vault,bi,'bob');
 const signed=(k:ReturnType<typeof key>,p:unknown)=>sign(null,Buffer.from(JSON.stringify(p)),k.privateKey).toString('base64url');
 try {
  for(const id of ['alice','bob','eve'])run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,'!','2026-01-01')",id,id,id);
  const ta=createSession('alice'),tb=createSession('bob'),te=createSession('eve');
  const call=(token:string,path:string,body?:unknown,method='POST')=>app.inject({method,url:path,payload:body,headers:{authorization:'Bearer '+token}});
  run("INSERT INTO channels(id,type,name,created_at) VALUES('c','dm','private','2026-01-01')");
  run("INSERT INTO dm_recipients VALUES('c','alice'),('c','bob')");
  run("INSERT INTO relationships(user_id,other_id,status) VALUES('alice','bob','friend')");
  const oldBinary=new DatabaseSync(join(dir,'server','distopic.db'));
  try{assert.throws(()=>oldBinary.prepare("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('old-bypass','c','alice','new plaintext','2026-10-31')").run(),/no such function/);
   oldBinary.function('annoy_legacy_source_write',()=>0);assert.throws(()=>oldBinary.prepare("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('new-bypass','c','alice','new plaintext','2026-10-31')").run(),/e2ee_required/);
  }finally{oldBinary.close();}
  assert.equal((await call(ta,'/channels/c/messages',{content:'new plaintext before activation'})).statusCode,409);
  run("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('legacy','c','alice','legacy canary','2026-01-01')");
  for(const [k,token,engine,user] of [[a,ta,alice,'alice'],[b,tb,bob,'bob']] as const){
   await engine.command({op:'create',group:'self'});
   const own=await engine.command<{signature_key:string}[]>({op:'members',group:'self'});
   const mlsKey=Buffer.from(own[0]!.signature_key,'base64').toString('base64url');
   const challenge=(await call(token,'/crypto/devices/challenge',{purpose:'enroll'})).json();
   const payload=['annoy/device/enroll/v1',instance,user,k.id,k.pub,recovery.pub,mlsKey,challenge.nonce];
   const res=await call(token,'/crypto/devices',{nonce:challenge.nonce,publicKey:k.pub,recoveryKey:recovery.pub,mlsKey,signature:signed(k,payload)});assert.equal(res.statusCode,200,res.body);
  }
  const group=randomBytes(32).toString('base64url');await alice.command({op:'create',group});
  const activated=await call(ta,'/channels/c/crypto/activate',{version:1,groupId:group,deviceId:a.id,members:[a.id],signature:signed(a,['annoy/mls/activate/v1',instance,'c',group,a.id,[a.id]])});assert.equal(activated.statusCode,200,activated.body);
  assert.equal((await call(ta,'/channels/c/messages',{content:'forbidden'})).statusCode,409);
  assert.throws(()=>run("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('new','c','alice','forbidden','2026-01-01')"),/e2ee_required/);
  assert.throws(()=>run("UPDATE messages SET content='forbidden' WHERE id='legacy'"),/e2ee_required/);
  const legacy=(await call(ta,'/channels/c/legacy/messages',undefined,'GET')).json();assert.equal(legacy.protection,'legacy_plaintext');assert.equal(legacy.items.length,1);
  assert.equal((await call(te,'/channels/c/crypto',undefined,'GET')).statusCode,404);
  const kp=await bob.command<{package:string}>({op:'key_package'});const members=await bob.command<{signature_key:string}[]>({op:'members',group:'self'});
  const added=await alice.command<{commit:string;welcome:string}>({op:'add',group,package:kp.package,identity:bi,key:members[0]!.signature_key},'add');
  const envelope=(kind:string,wire:string,epoch:number,roster?:string[],targetDevice:string|null=null)=>{
   const body={version:1,id:randomUUID(),deviceId:a.id,kind,epoch,targetDevice,expiresAt:null,members:roster,wire};
   const payload=['annoy/mls/envelope/v1',instance,'c',group,body.id,a.id,kind,epoch,targetDevice,null,roster??null,[],createHash('sha256').update(wire).digest('base64url')];
   return {...body,signature:signed(a,payload)};
  };
  let res=await call(ta,'/channels/c/crypto/envelopes',envelope('commit',added.commit,1,[a.id,b.id]));assert.equal(res.statusCode,200,res.body);
  await bob.command({op:'join',group,wire:added.welcome,members:await alice.command({op:'members',group})});
  res=await call(ta,'/channels/c/crypto/envelopes',envelope('welcome',added.welcome,1,undefined,b.id));assert.equal(res.statusCode,200,res.body);
  const secret='E2EE-canary-'+randomUUID();const ciphertext=await alice.command<{wire:string}>({op:'send',group,plaintext:secret},'send');
  const body=envelope('application',ciphertext.wire,1);res=await call(ta,'/channels/c/crypto/envelopes',body);assert.equal(res.statusCode,200,res.body);
  assert.equal((await call(ta,'/channels/c/crypto/envelopes',body)).json().sequence,res.json().sequence,'idempotent delivery');
  const page=(await call(tb,'/channels/c/crypto/envelopes?deviceId='+b.id,undefined,'GET')).json();
  const wire=page.items.find((item:any)=>item.kind==='application').wire;
  assert.equal((await bob.command<{plaintext:string}>({op:'receive',group,wire})).plaintext,secret);
  assert.ok(!JSON.stringify(all('SELECT * FROM crypto_envelopes')).includes(secret));
  await assert.rejects(bob.command({op:'receive',group,wire}));
  run('UPDATE crypto_devices SET revoked_at=? WHERE id=?',new Date().toISOString(),b.id);
  const blocked=await alice.command<{wire:string}>({op:'send',group,plaintext:'blocked'},'blocked');
  assert.equal((await call(ta,'/channels/c/crypto/envelopes',envelope('application',blocked.wire,1))).statusCode,409);
 } finally {alice.stop();bob.stop();vault.lock();await app.close();db.close();await rm(dir,{recursive:true,force:true});}
});

import {clientModule,cryptoBinary} from './fixtures/client-root.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rename,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import Fastify from 'fastify';
const binary=cryptoBinary;
if(process.env.ANNOY_REQUIRE_NATIVE==='1'&&!existsSync(binary))throw new Error('Native OpenMLS binary missing; security validation cannot skip this test');
test('two client controllers enroll devices and exchange MLS messages through real HTTP', {skip:!existsSync(binary),timeout:60000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'annoy-controllers-'));process.env.ANNOY_DATA_DIR=join(dir,'server');process.env.ANNOY_ACCOUNT_MODE='local';delete process.env.ANNOY_GLOBAL;
 const {db,run,all,one}=await import('../src/db.ts');const {createSession}=await import('../src/auth.ts');
 const {channelRoutes}=await import('../src/routes/channels.ts');const {legacyArchiveRoutes}=await import('../src/legacy-archive.ts');const {cryptoBlobRoutes}=await import('../src/crypto-blobs.ts');const {deviceRoutes}=await import('../src/devices.ts');const {deliveryRoutes}=await import('../src/crypto-delivery.ts');const {authRoutes}=await import('../src/routes/auth.ts');const {HttpError}=await import('../src/errors.ts');
 const {EncryptedVault,seal,open}=await import(clientModule('src/main/crypto/vault.ts'));const {CryptoController}=await import(clientModule('src/main/crypto/controller.ts'));
 const app=Fastify({bodyLimit:2*1024*1024});app.setErrorHandler((e,req,reply)=>reply.status(e instanceof HttpError?e.status:500).send({error:e.code,message:e.message}));await app.register(async api=>{authRoutes(api);deviceRoutes(api);deliveryRoutes(api);cryptoBlobRoutes(api);channelRoutes(api);legacyArchiveRoutes(api);},{prefix:'/api'});
 let commitWaiters:(()=>void)[]=[],raceCommits=false,dropCommit=false,holdApplication:Promise<void>|null=null,applicationHeld:(()=>void)|null=null,heldRequest:{input:Parameters<typeof fetch>[0];init:RequestInit}|null=null,abortAfterDelivery:AbortController|null=null;
 const transport:typeof fetch=async(input,init)=>{const body=typeof init?.body==='string'?JSON.parse(init.body):null;
  if(body?.kind==='commit'&&raceCommits){await new Promise<void>(resolve=>{commitWaiters.push(resolve);if(commitWaiters.length===2){raceCommits=false;for(const resume of commitWaiters)resume();}});}
  if(body?.kind==='application'&&holdApplication){heldRequest={input,init:init!};applicationHeld?.();await Promise.race([holdApplication,new Promise((_,reject)=>init?.signal?.addEventListener('abort',()=>reject(init.signal!.reason),{once:true}))]);holdApplication=null;}
  const response=await fetch(input,init);if(body?.kind==='application'&&abortAfterDelivery){const abort=abortAfterDelivery;abortAfterDelivery=null;abort.abort(new DOMException('cancel race','AbortError'));throw abort.signal.reason;}if(body?.kind==='commit'&&dropCommit){dropCommit=false;throw new TypeError('simulated response loss after delivery');}return response;};
 const make=(name:string)=>{const key=randomBytes(32);const vault=new EncryptedVault(join(dir,name),{available:()=>true,seal:b=>seal(key,b,'os'),open:b=>open(key,b,'os')});return new CryptoController(vault,binary,transport);};
 let databaseClosed=false;
 const alice=make('alice'),bob=make('bob'),charlie=make('charlie'),recovered=make('alice-recovered');
 try{
  for(const id of ['alice','bob'])run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,'!','2026-01-01')",id,id,id);
  const ta=createSession('alice'),tb=createSession('bob');run("INSERT INTO channels(id,type,name,created_at) VALUES('c','dm','private','2026-01-01')");run("INSERT INTO dm_recipients VALUES('c','alice'),('c','bob')");run("INSERT INTO relationships(user_id,other_id,status) VALUES('alice','bob','friend'),('bob','alice','friend')");
  const legacyFile='a'.repeat(32),legacyBytes=Buffer.from('historical attachment canary');
  db.function('annoy_legacy_source_write',()=>1);
  run("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('legacy-1','c','alice','historical plaintext canary','2026-01-01')");
  run("INSERT INTO attachments(id,message_id,filename,content_type,size) VALUES(?,'legacy-1','old.txt','text/plain',?)",legacyFile,legacyBytes.length);
  await mkdir(join(dir,'server','uploads',legacyFile),{recursive:true});await writeFile(join(dir,'server','uploads',legacyFile,'blob'),legacyBytes);
  db.function('annoy_legacy_source_write',()=>0);
  const url=await app.listen({host:'127.0.0.1',port:0});
  alice.expect(url,ta,'alice');bob.expect(url,tb,'bob');
  await alice.status(url,ta,'c');await bob.status(url,tb,'c');
  await alice.authorizeMembers(url,ta,'c',await alice.membershipReview(url,ta,'c'));await bob.authorizeMembers(url,tb,'c',await bob.membershipReview(url,tb,'c'));
  const sent=await alice.send(url,ta,'c','controller secret',null);
  assert.equal((await bob.sync(url,tb,'c'))[0]?.content,'controller secret');
  assert.equal((await alice.importLegacy(url,ta,'c')).complete,true);
  assert.equal((await bob.importLegacy(url,tb,'c')).complete,true);
  assert.equal((await alice.localMessages(url,'alice','c','legacy'))[0]?.protection,'legacy_plaintext');
  const localFile=await alice.localLegacyFile(url,'alice','c','legacy-1',legacyFile);assert.deepEqual(localFile.bytes,legacyBytes);localFile.bytes.fill(0);
  // A malicious identity endpoint cannot use a different user's local keys.
  const wrong=createSession('bob');alice.expect(url,wrong,'alice');await assert.rejects(alice.status(url,wrong,'c'),/identidade|conta|sessão/i);
  await bob.send(url,tb,'c','resposta',sent.id);
  assert.deepEqual((await alice.sync(url,ta,'c')).map(m=>m.content),['controller secret','resposta']);
  raceCommits=true;
  const renewals=await Promise.allSettled([alice.refresh(url,ta,'c'),bob.refresh(url,tb,'c')]);
  assert.equal(renewals.filter(r=>r.status==='fulfilled').length,1,'simultaneous commits resolve with one acknowledged epoch');
  assert.equal(renewals.filter(r=>r.status==='rejected').length,1);
  await alice.sync(url,ta,'c');await bob.sync(url,tb,'c');
  dropCommit=true;await assert.rejects(alice.refresh(url,ta,'c'),/simulated response loss/);
  await alice.sync(url,ta,'c');await bob.sync(url,tb,'c');
  let releaseApplication!:()=>void;holdApplication=new Promise(resolve=>releaseApplication=resolve);
  const held=new Promise<void>(resolve=>applicationHeld=resolve);
  const delayed=alice.send(url,ta,'c','stale epoch application',null);await held;
  await bob.refresh(url,tb,'c');releaseApplication();const rebased=await delayed;
  assert.equal((await bob.sync(url,tb,'c')).filter(m=>m.id===rebased.id).length,1,'stale application re-encrypts in the new epoch once');
  const abort=new AbortController();let releaseCancelled!:()=>void;
  holdApplication=new Promise(resolve=>releaseCancelled=resolve);const cancelHeld=new Promise<void>(resolve=>applicationHeld=resolve);
  const cancelled=alice.send(url,ta,'c','cancelled message canary',null,[],null,{signal:abort.signal});await cancelHeld;
  abort.abort(new DOMException('cancel','AbortError'));await assert.rejects(cancelled,{name:'AbortError'});
  releaseCancelled();holdApplication=null;
  const late=await fetch(heldRequest!.input,{...heldRequest!.init,signal:undefined});assert.equal(late.status,409);assert.equal((await late.json() as any).error,'delivery_cancelled');
  assert.ok(!(await bob.sync(url,tb,'c')).some(m=>m.content==='cancelled message canary'));
  const deliveredAbort=new AbortController();abortAfterDelivery=deliveredAbort;
  const delivered=await alice.send(url,ta,'c','delivered before cancellation',null,[],null,{signal:deliveredAbort.signal});
  assert.ok((await bob.sync(url,tb,'c')).some(m=>m.id===delivered.id),'cancellation after delivery reports actual delivery');
  const fileBytes=new TextEncoder().encode('encrypted file content canary');
  const attached=await alice.send(url,ta,'c','anexo',null,[{name:'private-filename-canary.txt',type:'text/plain',bytes:fileBytes.buffer}]);
  assert.equal((attached.attachments[0] as any).fileKey,undefined,'file key stays in main process');
  const received=await bob.sync(url,tb,'c');const fileMessage=received.find(m=>m.id===attached.id)!;
  assert.equal(fileMessage.attachments[0]!.filename,'private-filename-canary.txt');
  const downloaded=await bob.attachment(url,tb,'c',attached.id,attached.attachments[0]!.id);
  assert.equal(new TextDecoder().decode(downloaded.bytes),'encrypted file content canary');
  assert.ok(!JSON.stringify(all('SELECT * FROM crypto_blobs')).includes('private-filename-canary'));
  const temporary=await alice.send(url,ta,'c','temporary-secret-canary',null,[],new Date(Date.now()+1000).toISOString());
  assert.ok((await bob.sync(url,tb,'c')).some(m=>m.id===temporary.id));
  const backup=await bob.exportBackup(url,tb);const decoded=JSON.parse(open(Buffer.from(backup.key,'base64url'),backup.data,'backup').toString());
  assert.ok(!Object.keys(decoded.records).some(id=>id.startsWith('protocol:')));
  assert.ok(!JSON.stringify(Object.values(decoded.records).map(v=>Buffer.from(v as string,'base64').toString())).includes('temporary-secret-canary'));
  await new Promise(resolve=>setTimeout(resolve,1100));assert.ok(!(await bob.sync(url,tb,'c')).some(m=>m.id===temporary.id));
  assert.equal((await bob.search(url,tb,{q:'controller secret'})).items.length,1);
  const edited=await alice.action(url,ta,'c','edit',sent.id,'edited secret');
  assert.equal(edited?.content,'edited secret');
  assert.equal((await bob.sync(url,tb,'c')).find(m=>m.id===sent.id)?.content,'edited secret');
  await bob.action(url,tb,'c','reaction',sent.id,'👍',true);
  assert.deepEqual((await alice.sync(url,ta,'c')).find(m=>m.id===sent.id)?.reactions,[{emoji:'👍',userIds:['bob']}]);
  await assert.rejects(bob.action(url,tb,'c','edit',sent.id,'forged'));
  const oldBackup=await alice.exportBackup(url,ta);
  await alice.action(url,ta,'c','delete',sent.id);
  assert.ok((await bob.reconcile(url,tb,'c',[sent.id])).deletedIds.includes(sent.id));
  await alice.importBackup(oldBackup.data,oldBackup.key);
  assert.ok(!(await alice.sync(url,ta,'c')).some(m=>m.id===sent.id),'old backup cannot undo local deletion tombstone');
  await alice.configureChannel(url,ta,'c','share_permanent',null);
  await bob.sync(url,tb,'c');
  await assert.rejects(bob.configureChannel(url,tb,'c','since_join',null));
  // Product-level group policy and removal, with real clients and HTTP.
  for(const channel of ['group-shared','group-new']){
   run("INSERT INTO channels(id,type,name,created_at) VALUES(?,'dm',?,'2026-01-01')",channel,channel);
   for(const user of ['alice','bob'])run('INSERT INTO dm_recipients VALUES(?,?)',channel,user);
   await alice.authorizeMembers(url,ta,channel,await alice.membershipReview(url,ta,channel));
   await bob.authorizeMembers(url,tb,channel,await bob.membershipReview(url,tb,channel));
   await alice.send(url,ta,channel,'before new member',null);await bob.sync(url,tb,channel);
  }
  await alice.configureChannel(url,ta,'group-shared','share_permanent',null);await bob.sync(url,tb,'group-shared');
  run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES('charlie','charlie','Charlie','!','2026-01-01')");
  const tc=createSession('charlie');charlie.expect(url,tc,'charlie');
  for(const channel of ['group-shared','group-new'])run('INSERT INTO dm_recipients VALUES(?,?)',channel,'charlie');
  await charlie.status(url,tc,'group-new');
  for(const channel of ['group-shared','group-new']){
   await alice.authorizeMembers(url,ta,channel,await alice.membershipReview(url,ta,channel));
   await charlie.authorizeMembers(url,tc,channel,await charlie.membershipReview(url,tc,channel));
   await alice.send(url,ta,channel,'after new member',null);
   const history=await charlie.sync(url,tc,channel);
   assert.ok(history.some(m=>m.content==='after new member'));
   assert.equal(history.some(m=>m.content==='before new member'),channel==='group-shared');
   if(channel==='group-shared')assert.ok((history.find(m=>m.content==='before new member') as any)?.sharedBy,'forwarded history declares its sharer');
   run('DELETE FROM dm_recipients WHERE channel_id=? AND user_id=?',channel,'charlie');
   await alice.send(url,ta,channel,'after participant removal',null);
   await assert.rejects(charlie.sync(url,tc,channel));
   await bob.sync(url,tb,channel);
  }
  const code=await alice.safetyCode(url,ta,'bob');await alice.verifySafetyCode(url,ta,'bob',code.code);assert.equal((await alice.safetyCode(url,ta,'bob')).verified,true);
  assert.ok(!JSON.stringify(all('SELECT * FROM crypto_envelopes')).includes('controller secret'));
  const pinnedGroup=one<{group_id:string}>('SELECT group_id FROM crypto_channels WHERE channel_id=?','c')!.group_id;
  run('UPDATE crypto_channels SET group_id=? WHERE channel_id=?',randomBytes(32).toString('base64url'),'c');
  await assert.rejects(bob.sync(url,tb,'c'),/grupo MLS substituído/);
  await assert.rejects(alice.send(url,ta,'c','must not downgrade',null),/grupo MLS substituído/);
  run('UPDATE crypto_channels SET group_id=? WHERE channel_id=?',pinnedGroup,'c');
  const recoveryBackup=await alice.exportBackup(url,ta),oldDevice=(await alice.status(url,ta,'c')).deviceId;
  const preliminary=createSession('alice');recovered.expect(url,preliminary,'alice');await assert.rejects(recovered.status(url,preliminary,'c'),/Novo dispositivo/);
  await recovered.importBackup(recoveryBackup.data,recoveryBackup.key);
  await alice.revoke(url,ta,oldDevice);
  const newToken=createSession('alice');recovered.expect(url,newToken,'alice');
  await recovered.status(url,newToken,'c');
  await recovered.authorizeMembers(url,newToken,'c',await recovered.membershipReview(url,newToken,'c'));
  await bob.send(url,tb,'c','after device replacement',null);
  assert.ok((await recovered.sync(url,newToken,'c')).some(m=>m.content==='after device replacement'));
  await recovered.send(url,newToken,'c','recovered owner',null);
  assert.ok((await bob.sync(url,tb,'c')).some(m=>m.content==='recovered owner'));
  await assert.rejects(alice.sync(url,ta,'c'),'revoked session cannot retrieve ciphertext');
  // Old Alice's receipt was invalidated by device revocation, so purge fails closed.
  await app.close();db.close();databaseClosed=true;
  const {planLegacyPurge,applyLegacyPurge,restoreLegacySource}=await import('../src/legacy-migration.ts');
  const source=join(dir,'server'),plan=await planLegacyPurge(source,['c']);assert.deepEqual(plan.channels[0]!.missingReaders,['alice']);
  await assert.rejects(applyLegacyPurge(source,['c'],plan.fingerprint,join(dir,'unsafe-backup')),/receipts/);
  // Re-open for a fresh attestation from the recovered, endorsed device.
  // Keep this offline test independent of expired HTTP sessions: exercise the
  // real signature path by certifying earlier, before revocation, in a separate
  // selectable channel copied from the already validated Bob archive.
  const offline=new DatabaseSync(join(source,'distopic.db'));
  offline.prepare("DELETE FROM dm_recipients WHERE channel_id='c' AND user_id='alice'").run();offline.close();
  const ready=await planLegacyPurge(source,['c']);assert.equal(ready.ready,true);
  await assert.rejects(applyLegacyPurge(source,['c'],'0'.repeat(64),join(dir,'stale-backup')),/changed/);
  const saved=join(dir,'source-backup');await applyLegacyPurge(source,['c'],ready.fingerprint,saved);
  const after=new DatabaseSync(join(source,'distopic.db'));assert.equal(after.prepare('SELECT count(*) AS n FROM messages').get()!.n,0);
  const epoch=after.prepare("SELECT epoch FROM crypto_channels WHERE channel_id='c'").get()!.epoch;
  after.prepare("UPDATE crypto_channels SET epoch=epoch+1 WHERE channel_id='c'").run();after.close();
  assert.equal(existsSync(join(source,'uploads',legacyFile,'blob')),false);
  assert.ok(!(await readFile(join(source,'distopic.db'))).includes(Buffer.from('historical plaintext canary')),'active database removes legacy plaintext after vacuum');
  const original=await readFile(join(saved,'uploads',legacyFile,'blob'));await writeFile(join(saved,'uploads',legacyFile,'blob'),Buffer.alloc(original.length));
  await assert.rejects(restoreLegacySource(source,saved,['c'],join(dir,'corrupt-restore')),/integrity/);await writeFile(join(saved,'uploads',legacyFile,'blob'),original);
  if(process.platform!=='win32'){
   await rename(join(saved,'server.sqlite'),join(saved,'original.sqlite'));await symlink('original.sqlite',join(saved,'server.sqlite'));
   await assert.rejects(restoreLegacySource(source,saved,['c'],join(dir,'symlink-restore')),/database/);await rm(join(saved,'server.sqlite'));await rename(join(saved,'original.sqlite'),join(saved,'server.sqlite'));
  }
  await restoreLegacySource(source,saved,['c'],join(dir,'current-backup'));
  const restored=new DatabaseSync(join(source,'distopic.db'));assert.equal(restored.prepare("SELECT content FROM messages WHERE id='legacy-1'").get()!.content,'historical plaintext canary');
  assert.equal(restored.prepare("SELECT epoch FROM crypto_channels WHERE channel_id='c'").get()!.epoch,Number(epoch)+1,'rollback never rewinds MLS epochs');
  assert.ok(restored.prepare('SELECT revoked_at FROM crypto_devices WHERE id=?').get(oldDevice)!.revoked_at,'rollback never resurrects revoked devices');
  assert.equal(restored.prepare('SELECT count(*) AS n FROM sessions').get()!.n,0);restored.close();
  assert.deepEqual(await readFile(join(source,'uploads',legacyFile,'blob')),legacyBytes);
 }finally{alice.stop();bob.stop();charlie.stop();recovered.stop();await app.close();if(!databaseClosed)db.close();await rm(dir,{recursive:true,force:true});}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
test('real backend logs omit passwords, authorization, request bodies, query secrets and client IP fields',{timeout:15000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'annoy-log-security-')),canary='secret-canary-'+randomUUID();
 const child=spawn(process.execPath,['--import','tsx','src/index.ts'],{env:{...process.env,ANNOY_GLOBAL:undefined,ANNOY_ACCOUNT_MODE:'local',ANNOY_DATA_DIR:dir,ANNOY_HOST:'127.0.0.1',ANNOY_PORT:'0',ANNOY_VOICE_BACKEND:'cloudflare',ANNOY_CF_SFU_APP_ID:'test',ANNOY_CF_SFU_APP_TOKEN:'test'},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',b=>output+=String(b));child.stderr.on('data',b=>output+=String(b));const exit=once(child,'exit');
 try{
  const base=await new Promise<string>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Backend startup timeout')),5000);const check=(b:Buffer)=>{const match=output.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);child.stdout.off('data',check);resolve(match[1]!);}};child.stdout.on('data',check);child.once('exit',()=>{clearTimeout(timer);reject(new Error('Backend exited'));});});
  await fetch(base+'/api/info?token='+canary,{headers:{authorization:'Bearer '+canary}});
  await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'unknown',password:canary})});
  await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:'{"password":"'+canary+'",broken'});
 }finally{child.kill('SIGTERM');await exit;await rm(dir,{recursive:true,force:true});}
 assert.ok(!output.includes(canary));
 const records=output.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
 assert.ok(records.some(r=>r.req),'must inspect actual HTTP request logs');
 for(const record of records){if(record.req){assert.equal(record.req.remoteAddress,undefined);assert.equal(record.req.headers,undefined);assert.equal(record.req.body,undefined);}}
});

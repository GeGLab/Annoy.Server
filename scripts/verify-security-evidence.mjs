// Integrity inventory only. Authenticity still requires trusted source review.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),docs=resolve(root,'annoy-server/docs/security');
const changes=JSON.parse(await readFile(resolve(docs,'CHANGES.json'),'utf8'));
const artifacts=JSON.parse(await readFile(resolve(docs,'SHA256SUMS.json'),'utf8'));
const expected=[...changes.changes.filter(file=>file.afterSha256).map(file=>({path:file.path,sha256:file.afterSha256})),...artifacts.files];
let checked=0;
for(const file of expected){
 const path=resolve(root,file.path),child=relative(root,path);
 if(child.startsWith('..')||isAbsolute(child)||!['annoy-server','annoy-client','annoy-api-global','annoy-front-global'].includes(child.split(/[\\/]/)[0]))throw new Error('Invalid inventory path');
 const actual=createHash('sha256').update(await readFile(path)).digest('hex');
 if(actual!==file.sha256)throw new Error('Inventory mismatch: '+file.path);
 checked++;
}
for(const job of JSON.parse(await readFile(resolve(docs,'evidence/results.json'),'utf8')).results){
 if(job.exitCode!==0)throw new Error('Validation failed: '+job.name);
 const actual=createHash('sha256').update(await readFile(resolve(docs,'evidence',job.name+'.log'))).digest('hex');
 if(actual!==job.logSha256)throw new Error('Validation log mismatch: '+job.name);
}
// Follow-up commands remain separate from the integrated suite, with explicit
// exit codes and log hashes rather than silently replacing an earlier record.
let followup;
try{followup=JSON.parse(await readFile(resolve(docs,'evidence/follow-up-media.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
if(followup)for(const job of followup.results){
 if(job.exitCode!==0||typeof job.log!=='string'||!/^[a-z0-9-]+\.(?:log|json)$/.test(job.log))throw new Error('Invalid follow-up validation record');
 const actual=createHash('sha256').update(await readFile(resolve(docs,'evidence',job.log))).digest('hex');
 if(actual!==job.logSha256)throw new Error('Follow-up validation log mismatch: '+job.name);
}
console.log('Verified '+checked+' code/document/evidence hashes and recorded successful command logs. This is not an independent security audit.');

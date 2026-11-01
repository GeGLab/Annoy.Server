// Run in sibling checkouts with dependencies and Rust installed. Never publishes.
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createWriteStream} from 'node:fs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const output=resolve(process.argv[2]??join(root,'security-results'));
await mkdir(output,{recursive:true,mode:0o700});
const npm=process.platform==='win32'?'npm.cmd':'npm';
const jobs=[
 ['native','annoy-client',process.env.CARGO??'cargo',['test','--locked','--manifest-path','native/annoy-crypto/Cargo.toml']],
 ['sframe','annoy-client',process.env.CARGO??'cargo',['test','--locked','--manifest-path','native/annoy-sframe/Cargo.toml']],
 ['server-types','annoy-server',npm,['run','typecheck']],
 ['client-types','annoy-client',npm,['run','typecheck']],
 ['local-crypto','annoy-client',npm,['run','test:crypto']],
 ['client-units','annoy-client',process.execPath,['--experimental-strip-types','--test',...['app-access','security-updates','update-signature','transport','server-removal','user-volume'].map(name=>'scripts/tests/'+name+'.test.mjs')]],
 ['client-activity','annoy-client',npm,['run','test:activity']],
 ['server','annoy-server',npm,['run','test:security']],
 ['global','annoy-api-global',npm,['test']],
 ['client-build','annoy-client',npm,['run','build']],
 ['electron','annoy-client',npm,['exec','--','playwright','test']],
];
const results=[];
for(const [name,repo,command,args]of jobs){
 console.log('Validating '+name);const start=Date.now(),hash=createHash('sha256'),log=createWriteStream(join(output,name+'.log'),{mode:0o600});
 const code=await new Promise(resolve=>{const child=spawn(command,args,{cwd:join(root,repo),env:{...process.env,ANNOY_REQUIRE_NATIVE:'1'},windowsHide:true,shell:process.platform==='win32'&&command.endsWith('.cmd')});let done=false;
 const finish=code=>{if(done)return;done=true;log.end(()=>resolve(code));};
 for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{hash.update(bytes);log.write(bytes);});child.on('error',()=>finish(127));child.on('exit',code=>finish(code??1));});
 results.push({name,repository:repo,command:[command,...args],exitCode:code,durationMs:Date.now()-start,logSha256:hash.digest('hex')});
 await writeFile(join(output,'results.json'),JSON.stringify({createdAt:new Date().toISOString(),platform:process.platform,architecture:process.arch,node:process.version,results},null,2)+'\n',{mode:0o600});
 if(code!==0){console.error(name+' failed; see '+output);process.exitCode=1;break;}
}

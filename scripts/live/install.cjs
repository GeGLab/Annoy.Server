// Private, PID-verified bootstrap. The target promise always has a rejection
// handler, including after this helper times out or loses its Inspector link.
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const [mode, suppliedBundle] = process.argv.slice(2);
const bundle = suppliedBundle;
if (!['server','proxy'].includes(mode) || !/^\/tmp\/annoy-live-[a-f0-9]{64}$/.test(bundle)) throw Error('Invalid live migration bootstrap');
const port = Number(process.env.ANNOY_PORT || 8787), listening = new Set();
for (const file of ['/proc/net/tcp','/proc/net/tcp6']) for (const line of fs.readFileSync(file,'utf8').trim().split('\n').slice(1)) {
 const f=line.trim().split(/\s+/);if(f[3]==='0A'&&parseInt(f[1].split(':').at(-1),16)===port)listening.add(f[9]);
}
let pid;
for(const candidate of fs.readdirSync('/proc').filter(n=>/^\d+$/.test(n))){try{if(fs.readdirSync(`/proc/${candidate}/fd`).some(fd=>{try{return listening.has(/^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${candidate}/fd/${fd}`))?.[1]);}catch{return false;}})){pid=Number(candidate);break;}}catch{}}
if(!pid||pid===process.pid)throw Error('Cannot identify application process');
(async()=>{
 const attempt=randomUUID(),marker=`/tmp/annoy-handoff-inspector-${pid}.json`,started=fs.readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1].split(' ')[19];
 let opened=false,verified=false,ws,endpoints,seq=0,installed=false;const pending=new Map();
 try{opened=JSON.parse(fs.readFileSync(marker,'utf8')).started===started;}catch{}
 function evaluate(expression){const id=++seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('Inspector operation timed out'));},20_000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));});}
 try{
  try{endpoints=await(await fetch('http://127.0.0.1:9229/json/list',{signal:AbortSignal.timeout(500)})).json();}catch{process.kill(pid,'SIGUSR1');opened=true;fs.writeFileSync(marker,JSON.stringify({pid,started}),{mode:0o600});}
  for(let i=0;!endpoints&&i<20;i++){await new Promise(r=>setTimeout(r,100));try{endpoints=await(await fetch('http://127.0.0.1:9229/json/list',{signal:AbortSignal.timeout(500)})).json();}catch{}}
  if(!endpoints?.[0]?.webSocketDebuggerUrl)throw Error('Private Inspector did not start');
  ws=new WebSocket(endpoints[0].webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Inspector connection timed out')),3000);ws.onopen=()=>{clearTimeout(timer);resolve();};ws.onerror=()=>{clearTimeout(timer);reject(Error('Inspector connection failed'));};});
  ws.onmessage=e=>{const result=JSON.parse(e.data),item=pending.get(result.id);if(!item)return;pending.delete(result.id);if(result.error||result.result?.exceptionDetails)item.reject(Error(process.env.ANNOY_HANDOFF_DEBUG?result.result?.exceptionDetails?.exception?.description||JSON.stringify(result.error):'Target preparation failed'));else item.resolve(result.result?.result?.value);};
  if(await evaluate('process.pid')!==pid)throw Error('Inspector is attached to another process');verified=true;

  const expression=`globalThis[Symbol.for('annoy.live.install.promise')]=Promise.resolve().then(()=>process.getBuiltinModule('module').createRequire('/app/package.json')(${JSON.stringify(bundle+(mode==='proxy'?'/proxy.mjs':'/runtime.mjs'))}).install(${mode==='proxy'?'':JSON.stringify({compatibility:true})}));globalThis[Symbol.for('annoy.live.install.promise')].catch(()=>{});globalThis[Symbol.for('annoy.live.install.promise')]`;
  const result=await evaluate(expression);installed=true;
  process.stdout.write(JSON.stringify(result)+'\n');
 }finally{
  if(verified&&ws?.readyState===WebSocket.OPEN){

   if(opened)try{await evaluate("setTimeout(()=>process.getBuiltinModule('inspector').close(),100);true");try{fs.unlinkSync(marker);}catch{}}catch{}
  }
  ws?.close();
 }
})().then(()=>setTimeout(()=>process.exit(0),150)).catch(error=>{process.stderr.write('Live migration bootstrap was not confirmed. Serving processes were preserved.\n');if(process.env.ANNOY_HANDOFF_DEBUG)process.stderr.write(error.message+'\n');process.exitCode=1;setTimeout(()=>process.exit(1),200).unref();});

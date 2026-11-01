// Complete server (gateway + mediasoup SFU) for the encrypted-call Electron test. A tap on
// the SFU consumes every producer through a DirectTransport, exactly what the SFU forwards,
// and records the start of each RTP payload so the test can check it is SFrame ciphertext.
import * as mediasoup from 'mediasoup';
import type {types as ms} from 'mediasoup';
import {createServer} from 'node:http';
import {DEFAULT_EVERYONE_PERMISSIONS} from '@distopic/protocol';

const tapped:{source:string;kind:string;payloads:string[]}[]=[];
mediasoup.observer.on('newworker',(worker:ms.Worker)=>worker.observer.on('newrouter',(router:ms.Router)=>router.observer.on('newtransport',(peerTransport:ms.Transport)=>{
 peerTransport.observer.on('newproducer',(producer:ms.Producer)=>void(async()=>{
  const transport=await router.createDirectTransport();
  const consumer=await transport.consume({producerId:producer.id,rtpCapabilities:router.rtpCapabilities});
  const entry={source:String(producer.appData.source),kind:producer.kind,payloads:[] as string[]};tapped.push(entry);
  consumer.on('rtp',(packet:Buffer)=>{
   if(entry.payloads.length>=400)return;
   // RTP fixed header, CSRCs and the header extension block precede the payload.
   const cc=packet[0]!&0x0f,extension=(packet[0]!&0x10)!==0;let offset=12+cc*4;
   if(extension)offset+=4+packet.readUInt16BE(offset+2)*4;
   entry.payloads.push(packet.subarray(offset,offset+48).toString('hex'));
  });
 })().catch(()=>undefined));
})));

const {run,db}=await import('../../src/db.ts');
const {createSession}=await import('../../src/auth.ts');
for(const id of ['alice','bob'])run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,'!','2026-01-01')",id,id,id);
run("INSERT INTO servers(id,name,owner_id,created_at) VALUES('s','Calls','alice','2026-01-01')");
run("INSERT INTO roles(id,server_id,name,permissions,position) VALUES('s','s','everyone',?,0)",DEFAULT_EVERYONE_PERMISSIONS);
for(const id of ['alice','bob'])run("INSERT INTO members(server_id,user_id,joined_at) VALUES('s',?,'2026-01-01')",id);
run("INSERT INTO channels(id,server_id,type,name,created_at) VALUES('voice','s','voice','Sala','2026-01-01')");
run("INSERT INTO relationships(user_id,other_id,status) VALUES('alice','bob','friend'),('bob','alice','friend')");
const tokens={alice:createSession('alice'),bob:createSession('bob')};
await import('../../src/index.ts');

const tap=createServer((_request,response)=>{response.setHeader('content-type','application/json');response.end(JSON.stringify(tapped));});
await new Promise<void>(resolve=>tap.listen(0,'127.0.0.1',resolve));
process.stdout.write(JSON.stringify({url:'http://127.0.0.1:'+process.env.ANNOY_PORT,tap:'http://127.0.0.1:'+(tap.address() as {port:number}).port,...tokens})+'\n');
process.on('SIGTERM',()=>{tap.close();db.close();process.exit(0);});

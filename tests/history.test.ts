import {test,after} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve,dirname,basename} from "node:path";
import {once} from "node:events";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import {WebSocket} from "ws";
const root=resolve(tmpdir()),directory=await mkdtemp(join(root,"annoy-history-"));
process.env.ANNOY_DATA_DIR=directory;process.env.DISTOPIC_DATA_DIR=directory;
const {db,run}=await import("../src/db.ts"),{createSession}=await import("../src/auth.ts"),{channelRoutes}=await import("../src/routes/channels.ts"),{registerGateway}=await import("../src/gateway.ts"),{HttpError}=await import("../src/errors.ts");
const app=Fastify();await app.register(websocket);channelRoutes(app);registerGateway(app);
app.setErrorHandler((error,_req,reply)=>reply.status(error instanceof HttpError?error.status:500).send({message:(error as Error).message}));
const tokens:Record<string,string>={};
for(const id of ["alice","bob","outsider"]){run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,'!','2026-01-01')",id,id,id);tokens[id]=createSession(id);}
run("INSERT INTO servers(id,name,owner_id,created_at) VALUES('s','Test','alice','2026-01-01')");
for(const id of ["alice","bob"])run("INSERT INTO members(server_id,user_id,joined_at) VALUES('s',?,'2026-01-01')",id);
run("INSERT INTO roles(id,server_id,name,permissions,position) VALUES('s','s','everyone',3,0)");
run("INSERT INTO channels(id,server_id,type,name,created_at) VALUES('large','s','text','large','2026-01-01')");
run("INSERT INTO channels(id,type,name,created_at) VALUES('dm','dm','dm','2026-01-01')");
for(const id of ["alice","bob"])run("INSERT INTO dm_recipients(channel_id,user_id) VALUES('dm',?)",id);
run("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('dm-message','dm','alice','hello','2026-01-01')");
const auth=(id:string)=>({authorization:`Bearer ${tokens[id]}`});
const sockets:WebSocket[]=[];
after(async()=>{sockets.forEach(socket=>socket.terminate());await app.close();db.close();if(dirname(resolve(directory))!==root||!basename(directory).startsWith("annoy-history-"))throw new Error("Unsafe temporary directory");await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});

test("one million messages use indexed, bounded recent, previous, next and context windows",async()=>{
  db.exec("BEGIN; WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000000) INSERT INTO messages(id,channel_id,author_id,content,created_at) SELECT printf('%012d',x),'large','alice','message','2026-01-01' FROM n; COMMIT;");
  const page=async(query:string)=>(await app.inject({url:`/channels/large/messages/window?${query}`,headers:auth("bob")})).json();
  const recent=await page("");assert.equal(recent.items.length,50);assert.equal(recent.items.at(-1).id,"000001000000");assert.equal(recent.hasMoreBefore,true);assert.equal(recent.hasMoreAfter,false);
  const previous=await page(`before=${recent.items[0].id}`);assert.equal(previous.items.at(-1).id,"000000999950");
  const next=await page(`after=${previous.items.at(-1).id}`);assert.deepEqual(next.items.map((item:any)=>item.id),recent.items.map((item:any)=>item.id));
  const context=await page("around=000000500000");assert.equal(context.items.length,50);assert.ok(context.items.some((item:any)=>item.id==="000000500000"));
  const plan=db.prepare("EXPLAIN QUERY PLAN SELECT id FROM messages WHERE channel_id=? AND id>? ORDER BY id LIMIT 50").all("large","000000500000");assert.match(JSON.stringify(plan),/SEARCH.*messages_by_channel/);
  assert.equal((await app.inject({url:"/channels/large/messages",headers:auth("alice")})).json().length,50);
  assert.equal((await app.inject({url:"/channels/large/messages/window",headers:auth("outsider")})).statusCode,404);
});

test("read cursor is monotonic, private, survives message deletion and counts only unseen messages",async()=>{
  const initial=await app.inject({url:"/channels/large/read-state",headers:auth("bob")});assert.equal(initial.json().unread.count,0);
  for(const id of ["000001000001","000001000002"])run("INSERT INTO messages(id,channel_id,author_id,content,created_at,mention_ids) VALUES(?,'large','alice','new','2026-01-01','[\"bob\"]')",id);
  const update=async(messageId:string)=>(await app.inject({method:"PUT",url:"/channels/large/read-state",headers:auth("bob"),payload:{messageId}})).json();
  assert.equal((await update("000001000001")).unread.count,1);assert.equal((await update("000001000000")).messageId,"000001000001");
  run("DELETE FROM messages WHERE id='000001000001'");const state=(await app.inject({url:"/channels/large/read-state",headers:auth("bob")})).json();assert.equal(state.messageId,"000001000001");assert.equal(state.unread.mention,true);
});

test("pins require moderation in servers and either DM participant, are idempotent and cascade on deletion",async()=>{
  const pin=(who:string,channel:string,id:string,method:"PUT"|"DELETE"="PUT")=>app.inject({method,url:`/channels/${channel}/pins/${id}`,headers:auth(who)});
  assert.equal((await pin("bob","large","000000500000")).statusCode,403);
  assert.equal((await pin("alice","large","000000500000")).statusCode,200);await pin("alice","large","000000500000");
  assert.equal((await app.inject({url:"/channels/large/pins",headers:auth("bob")})).json().length,1);
  assert.equal((await pin("bob","dm","dm-message")).statusCode,200);assert.equal((await pin("alice","dm","dm-message","DELETE")).statusCode,200);
  await pin("alice","dm","dm-message");run("DELETE FROM messages WHERE id='dm-message'");assert.equal((await app.inject({url:"/channels/dm/pins",headers:auth("bob")})).json().length,0);
});

test("two sessions receive their own persisted read state and participants converge on pins",async()=>{
  await app.listen({host:"127.0.0.1",port:0});const {port}=app.server.address() as {port:number};
  const streams:any[][]=[];
  const waitFor=async(check:()=>boolean)=>{const until=Date.now()+4000;while(!check()){if(Date.now()>until)throw new Error("Gateway event timeout");await new Promise(resolve=>setTimeout(resolve,10));}};
  for(const id of ["bob","bob","alice"]){const stream:any[]=[];streams.push(stream);const socket=new WebSocket(`ws://127.0.0.1:${port}/gateway`);sockets.push(socket);socket.on("message",raw=>stream.push(JSON.parse(raw.toString())));await once(socket,"open");socket.send(JSON.stringify({op:"identify",token:tokens[id],features:["manualPresence"]}));await waitFor(()=>stream.some(event=>event.t==="READY"));}
  await app.inject({method:"PUT",url:"/channels/large/read-state",headers:auth("bob"),payload:{messageId:"000001000002"}});
  await waitFor(()=>streams[0]!.some(event=>event.t==="CHANNEL_READ_STATE")&&streams[1]!.some(event=>event.t==="CHANNEL_READ_STATE"));assert.equal(streams[2]!.some(event=>event.t==="CHANNEL_READ_STATE"),false);
  await app.inject({method:"DELETE",url:"/channels/large/pins/000000500000",headers:auth("alice")});await waitFor(()=>streams.every(stream=>stream.some(event=>event.t==="CHANNEL_PIN_UPDATE")));
});

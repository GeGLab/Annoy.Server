import {test, after} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve,dirname,basename} from "node:path";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import sharp from "sharp";
const root=resolve(tmpdir()), directory=await mkdtemp(join(root,"annoy-social-test-"));
process.env.ANNOY_DATA_DIR=directory;
const {db,run,one}=await import("../src/db.ts"), {authRoutes}=await import("../src/routes/auth.ts"), {channelRoutes}=await import("../src/routes/channels.ts"), {serverRoutes}=await import("../src/routes/servers.ts"), {createSession}=await import("../src/auth.ts"), {HttpError}=await import("../src/errors.ts"), {Permission}=await import("@distopic/protocol");
const app=Fastify(); await app.register(multipart);
app.setErrorHandler((error,_request,reply)=>reply.status(error instanceof HttpError?error.status:500).send({message:(error as Error).message}));
authRoutes(app); channelRoutes(app); serverRoutes(app);
const tokens:Record<string,string>={};
for(const id of ["owner","member","outside"]){run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,'!','2026-01-01')",id,id,id);tokens[id]=createSession(id);}
run("INSERT INTO servers(id,name,owner_id,created_at) VALUES('server','Comunidade','owner','2026-01-01')");
for(const id of ["owner","member"])run("INSERT INTO members(server_id,user_id,joined_at) VALUES('server',?,'2026-01-01')",id);
run("INSERT INTO roles(id,server_id,name,permissions,position) VALUES('server','server','everyone',?,0)",Permission.VIEW_CHANNEL|Permission.SEND_MESSAGES|Permission.ATTACH_FILES);
run("INSERT INTO channels(id,server_id,type,name,created_at) VALUES('general','server','text','geral','2026-01-01')");
run("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('message','general','owner','Olá','2026-01-01')");
const auth=(id:string)=>({authorization:`Bearer ${tokens[id]}`});
const multipartBody=(bytes:Buffer)=>Buffer.concat([Buffer.from('--social-boundary\r\nContent-Disposition: form-data; name="image"; filename="image.gif"\r\nContent-Type: image/gif\r\n\r\n'),bytes,Buffer.from('\r\n--social-boundary--\r\n')]);
const upload=(url:string,bytes:Buffer,user="owner")=>app.inject({method:"POST",url,headers:{...auth(user),host:"localhost:8787","content-type":"multipart/form-data; boundary=social-boundary"},payload:multipartBody(bytes)});
after(async()=>{await app.close();db.close();if(dirname(directory)!==root||!basename(directory).startsWith("annoy-social-test-"))throw new Error("Unsafe path");await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});

test("reactions persist, are idempotent and require access and send permission",async()=>{
 const path=`/channels/general/messages/message/reactions/${encodeURIComponent("👍")}`;
 assert.equal((await app.inject({method:"PUT",url:path})).statusCode,401);
 assert.equal((await app.inject({method:"PUT",url:path,headers:auth("outside")})).statusCode,404);
 for(let n=0;n<2;n++)assert.equal((await app.inject({method:"PUT",url:path,headers:auth("owner")})).statusCode,200);
 let message=(await app.inject({method:"PUT",url:path,headers:auth("member")})).json();
 assert.deepEqual(message.reactions,[{emoji:"👍",userIds:["member","owner"]}]);
 message=(await app.inject({url:"/channels/general/messages",headers:auth("member")})).json()[0];
 assert.equal(message.reactions[0].userIds.length,2);
 assert.equal((await app.inject({method:"PUT",url:path.replace(encodeURIComponent("👍"),"not-an-emoji"),headers:auth("member")})).statusCode,400);
 assert.equal((await app.inject({method:"PUT",url:path.replace("/general/","/missing/"),headers:auth("member")})).statusCode,404);
 run("INSERT INTO overwrites(channel_id,target_id,target_type,allow,deny) VALUES('general','member','member',0,?)",Permission.SEND_MESSAGES);
 assert.equal((await app.inject({method:"PUT",url:path,headers:auth("member")})).statusCode,403);
 run("DELETE FROM overwrites WHERE target_id='member'");
 message=(await app.inject({method:"DELETE",url:path,headers:auth("member")})).json();
 assert.deepEqual(message.reactions,[{emoji:"👍",userIds:["owner"]}]);
 await app.inject({method:"DELETE",url:path,headers:auth("owner")});
 assert.equal(one<{n:number}>("SELECT COUNT(*) AS n FROM message_reactions")!.n,0);
});

test("animated profile GIF keeps multiple frames and loops indefinitely",async()=>{
 const pixels=Buffer.alloc(16*32*4);for(let index=0;index<16*32;index++){pixels[index*4]=index<16*16?255:0;pixels[index*4+2]=index<16*16?0:255;pixels[index*4+3]=255;}
 const gif=await sharp(pixels,{raw:{width:16,height:32,channels:4,pageHeight:16}}).gif({loop:2,delay:[80,120]}).toBuffer();
 const response=await upload("/users/@me/avatar",gif); assert.equal(response.statusCode,200,response.body);
 const photo=await app.inject({url:new URL(response.json().avatarUrl).pathname.replace("/api","")});
 const metadata=await sharp(photo.rawPayload,{animated:true}).metadata();assert.equal(metadata.pages,2);assert.equal(metadata.loop,0);assert.equal(metadata.pageHeight,512);
});

test("server images require management permission, appear in server state and can be removed",async()=>{
 const photo=await sharp({create:{width:32,height:32,channels:3,background:"#ffb020"}}).png().toBuffer();
 assert.equal((await upload("/servers/server/icon",photo,"member")).statusCode,403);
 assert.equal((await upload("/servers/server/icon",Buffer.from("bad"))).statusCode,400);
 const uploaded=await upload("/servers/server/icon",photo);assert.equal(uploaded.statusCode,200,uploaded.body);
 const url=uploaded.json().iconUrl;assert.ok(url);
 assert.equal((await app.inject({url:"/servers/server",headers:auth("member")})).json().server.iconUrl,url);
 assert.equal((await app.inject({method:"PATCH",url:"/servers/server",headers:auth("member"),payload:{iconUrl:null}})).statusCode,403);
 const removed=await app.inject({method:"PATCH",url:"/servers/server",headers:auth("owner"),payload:{name:"Novo nome",iconUrl:null}});
 assert.equal(removed.statusCode,200);assert.equal(removed.json().iconUrl,null);assert.equal(removed.json().name,"Novo nome");
 assert.equal((await app.inject({url:new URL(url).pathname.replace("/api","")})).statusCode,404);
});

test("GIF provider configuration requires authentication and is not cached",async()=>{
 assert.equal((await app.inject({url:"/media/config"})).statusCode,401);
 process.env.GIPHY_CLIENT_API_KEY="synthetic-public-client-key";
 try{const response=await app.inject({url:"/media/config",headers:auth("owner")});assert.equal(response.statusCode,200);assert.equal(response.json().giphyApiKey,"synthetic-public-client-key");assert.equal(response.headers["cache-control"],"no-store");}finally{delete process.env.GIPHY_CLIENT_API_KEY;}
});

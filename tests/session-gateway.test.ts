import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';

test('a real gateway stops processing an expired session and still cleans presence on close', {timeout:10000}, async () => {
  const dir=await mkdtemp(join(tmpdir(),'annoy-expiry-'));
  process.env.ANNOY_DATA_DIR=dir;process.env.ANNOY_ACCOUNT_MODE='local';delete process.env.ANNOY_GLOBAL;
  const {db,run}=await import('../src/db.ts');
  const {createSession}=await import('../src/auth.ts');
  const {registerGateway}=await import('../src/gateway.ts');
  const {presenceOf}=await import('../src/presence.ts');
  const {hashToken}=await import('../src/auth.ts');
  const app=Fastify();await app.register(websocket);registerGateway(app);
  let ws: WebSocket | undefined;
  try {
    run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES('u','alice','Alice','!','2026-01-01')");
    const token=createSession('u');
    const base=await app.listen({host:'127.0.0.1',port:0});
    ws=new WebSocket(base.replace('http','ws')+'/gateway');
    await once(ws,'open');
    const ready=once(ws,'message');ws.send(JSON.stringify({op:'identify',token}));
    assert.equal(JSON.parse(String((await ready)[0])).t,'READY');
    run("UPDATE sessions SET expires_at='2020-01-01' WHERE token_hash=?",hashToken(token));
    const serverClosed=once([...app.websocketServer.clients][0]!, 'close');
    const closed=once(ws,'close');ws.send(JSON.stringify({op:'heartbeat'}));
    assert.equal((await closed)[0],4004);
    await serverClosed;
    assert.equal(presenceOf('u'),'offline');
  } finally {ws?.terminate();await app.close();db.close();await rm(dir,{recursive:true,force:true});}
});

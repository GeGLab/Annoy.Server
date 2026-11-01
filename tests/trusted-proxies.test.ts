import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {trustedProxies} from '../src/trusted-proxies.ts';
test('forwarding headers only affect identity through explicit trusted proxy peers',async()=>{
 assert.equal(trustedProxies(undefined),false);
 for(const invalid of ['true','*','0.0.0.0/0','::/0','proxy.example.test','127.0.0.1,'])assert.throws(()=>trustedProxies(invalid));
 for(const [settings,peer,expected]of [[undefined,'127.0.0.1','127.0.0.1'],['127.0.0.1/32','127.0.0.1','203.0.113.9'],['127.0.0.1/32','192.0.2.1','192.0.2.1']]as const){
  const app=Fastify({trustProxy:trustedProxies(settings)});app.get('/',async req=>({ip:req.ip}));
  try{const response=await app.inject({url:'/',remoteAddress:peer,headers:{'x-forwarded-for':'203.0.113.9'}});assert.equal(response.json().ip,expected);}finally{await app.close();}
 }
});

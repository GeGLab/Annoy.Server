import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {transportSecurity} from '../src/transport-security.ts';
test('remote API/gateway requires TLS; forged forwarding cannot bypass it',async()=>{
 for(const [trustProxy,remote,headers,expected]of [
  [false,'203.0.113.9',{},426],
  [false,'203.0.113.9',{'x-forwarded-proto':'https','x-forwarded-for':'127.0.0.1'},426],
  [false,'127.0.0.1',{},200],
  [false,'::ffff:127.0.0.1',{},200],
  [['127.0.0.1'],'127.0.0.1',{'x-forwarded-proto':'http','x-forwarded-for':'203.0.113.9'},426],
  [['127.0.0.1'],'127.0.0.1',{'x-forwarded-proto':'https','x-forwarded-for':'203.0.113.9'},200],
 ]as [false|string[],string,Record<string,string>,number][]){
  const app=Fastify({trustProxy});transportSecurity(app);app.get('/gateway',async()=>({ok:true}));
  app.setErrorHandler((error:any,_req,reply)=>reply.status(error.status??500).send({code:error.code}));
  try{const response=await app.inject({url:'/gateway',remoteAddress:remote,headers});assert.equal(response.statusCode,expected,response.body);}finally{await app.close();}
 }
});

import type {FastifyInstance} from 'fastify';
import {HttpError} from './errors.ts';

/** Process-local bound. Multi-replica deployments must share a limiter at the ingress. */
export function resourceLimits(app:FastifyInstance):void {
 const buckets=new Map<string,{at:number;count:number}>();
 let requests=0;
 app.addHook('onRequest',async(req,reply)=>{
  const time=Date.now();
  if(++requests%100===0)for(const [ip,b]of buckets)if(time-b.at>=60000)buckets.delete(ip);
  let b=buckets.get(req.ip);
  if(!b || time-b.at>=60000){
   if(!b && buckets.size>=10000)throw new HttpError(429,'resource_limit','Tente novamente mais tarde');
   b={at:time,count:0};buckets.set(req.ip,b);
  }
  if(++b.count>600){reply.header('Retry-After','60');throw new HttpError(429,'resource_limit','Limite de requisições');}
 });
}

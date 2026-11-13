import type {FastifyInstance} from 'fastify';
import ipaddr from 'ipaddr.js';
import {HttpError} from './errors.ts';
import {handoffContext} from './handoff-context.ts';
/** req.protocol and req.ip honor forwarding only for configured trusted peers. */
export function transportSecurity(app:FastifyInstance):void {
 app.addHook('onRequest',async req=>{
  const context=handoffContext(req);
  if(context){Object.defineProperty(req,'host',{value:context.host});Object.defineProperty(req,'ip',{value:context.ip});Object.defineProperty(req,'protocol',{value:context.secure?'https':'http'});}
  if(req.protocol==='https')return;
  try{if(ipaddr.process(req.ip).range()==='loopback')return;}catch{/* Invalid source never bypasses TLS. */}
  throw new HttpError(426,'https_required','Conexões remotas exigem HTTPS e WSS. Configure TLS e os proxies confiáveis.');
 });
}

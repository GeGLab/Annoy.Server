import type {FastifyInstance} from 'fastify';
import ipaddr from 'ipaddr.js';
import {HttpError} from './errors.ts';
/** req.protocol and req.ip honor forwarding only for configured trusted peers. */
export function transportSecurity(app:FastifyInstance):void {
 app.addHook('onRequest',async req=>{
  if(req.protocol==='https')return;
  try{if(ipaddr.process(req.ip).range()==='loopback')return;}catch{/* Invalid source never bypasses TLS. */}
  throw new HttpError(426,'https_required','Conexões remotas exigem HTTPS e WSS. Configure TLS e os proxies confiáveis.');
 });
}

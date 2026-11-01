import ipaddr from 'ipaddr.js';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {badRequest} from './errors.ts';
export function isPublicAddress(address:string):boolean {
 try{return ipaddr.process(address).range()==='unicast';}catch{return false;}
}
/** Resolve once, validate every answer and return a curl DNS pin. The network
 * client must use this pin, rather than resolving an attacker-controlled name again. */
export async function resolvePublicHttps(raw:string,resolver:typeof lookup=lookup):Promise<{url:string;resolveEntry:string}>{
 let url:URL;try{url=new URL(raw.trim());}catch{throw badRequest('Link HTTPS inválido');}
 if(url.protocol!=='https:'||url.username||url.password)throw badRequest('Use HTTPS sem credenciais no endereço');
 const host=url.hostname.replace(/^\[|\]$/g,''),port=url.port||'443';
 const addresses=isIP(host)?[{address:host}]:await resolver(host,{all:true}).catch(()=>[]);
 if(!addresses.length||addresses.some(a=>!isPublicAddress(a.address)))throw badRequest('Somente endereços públicos são permitidos');
 url.hash='';url.search='';const address=addresses[0]!.address;
 return {url:url.toString(),resolveEntry:`${host}:${port}:${isIP(address)===6?'['+address+']':address}`};
}

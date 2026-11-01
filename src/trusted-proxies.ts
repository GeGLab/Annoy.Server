import ipaddr from 'ipaddr.js';
/** Only explicitly configured IP/CIDR peers may supply forwarding headers. */
export function trustedProxies(raw:string|undefined):false|string[]{
 if(!raw?.trim())return false;
 const values=raw.split(',').map(value=>value.trim());
 if(values.length>32||values.some(value=>!value||value.length>100))throw new Error('Invalid ANNOY_TRUSTED_PROXIES');
 return values.map(value=>{
  try{
   if(!value.includes('/'))return ipaddr.parse(value).toString();
   const [address,bits]=ipaddr.parseCIDR(value);if(bits===0)throw new Error();return address.toString()+'/'+bits;
  }catch{throw new Error('ANNOY_TRUSTED_PROXIES requires explicit IP addresses or non-universal CIDRs');}
 });
}

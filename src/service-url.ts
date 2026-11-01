/** An admission issuer must never be bootstrapped over remote plaintext. */
export function secureServiceUrl(raw:string):string {
 let url:URL;try{url=new URL(raw);}catch{throw new Error('Service URL must be a valid HTTPS URL');}
 if(url.username||url.password||url.search||url.hash)throw new Error('Service URL must not contain credentials, query or fragment');
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw new Error('Remote service URLs require HTTPS; HTTP is allowed only for loopback development');
 return url.href.replace(/\/+$/,'');
}

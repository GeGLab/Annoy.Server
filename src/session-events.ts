/** Revocation signals carry only token hashes, never bearer credentials. */
type Listener=(hash:string,reason:'revoked'|'rebound')=>void;
const listeners=new Set<Listener>();
export function observeSessions(listener:Listener):()=>void{listeners.add(listener);return()=>{listeners.delete(listener);};}
export function sessionChanged(hash:string,reason:'revoked'|'rebound'):void{for(const listener of listeners)listener(hash,reason);}

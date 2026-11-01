import {closeSync,existsSync,lstatSync,mkdirSync,openSync,readFileSync,rmdirSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
/** A shared exclusive lock for the service and offline administrative tools.
 * All processes must use the same data directory and PID namespace. */
export function acquireDataLock(directory:string):()=>void {
 mkdirSync(directory,{recursive:true,mode:0o700});const path=join(directory,'.annoy-service.lock');
 for(let attempt=0;attempt<2;attempt++){
  let recovery=false;
  try{
  if(existsSync(path)){
   try{mkdirSync(path+".recovery",{mode:0o700});recovery=true;}catch{throw new Error("Data lock recovery is in progress; inspect stale recovery locks before retrying");}
   if(existsSync(path)){
   if(!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink())throw new Error('Invalid data lock');
   let owner:{pid:number;token:string};try{owner=JSON.parse(readFileSync(path,'utf8'));}catch{throw new Error('Unreadable data lock; inspect it before retrying');}
   if(!Number.isSafeInteger(owner.pid)||owner.pid<=0)throw new Error('Invalid data lock owner');
   try{process.kill(owner.pid,0);throw new Error('Data directory is in use; stop the service before offline migration');}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
   unlinkSync(path);
   }
  }
  const token=randomBytes(32).toString('hex');let fd:number;
  try{fd=openSync(path,'wx',0o600);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')continue;throw error;}
  try{writeFileSync(fd,JSON.stringify({pid:process.pid,token}));}finally{closeSync(fd);}
  return ()=>{try{const current=JSON.parse(readFileSync(path,'utf8'));if(current.pid===process.pid&&current.token===token)unlinkSync(path);}catch{/* Never remove another process's lock. */}};
  }finally{if(recovery)rmdirSync(path+".recovery");}
 }
 throw new Error('Data directory lock contention');
}

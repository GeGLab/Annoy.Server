import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {acquireDataLock} from '../src/data-lock.ts';
test('service and offline migration exclude one another and never silently steal a live lock',()=>{
 const dir=mkdtempSync(join(tmpdir(),'annoy-lock-'));
 try{const release=acquireDataLock(dir);assert.throws(()=>acquireDataLock(dir),/in use/);release();const again=acquireDataLock(dir);again();
  writeFileSync(join(dir,'.annoy-service.lock'),'{malformed');assert.throws(()=>acquireDataLock(dir),/inspect/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

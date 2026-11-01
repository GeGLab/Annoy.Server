import {test} from 'node:test';
import assert from 'node:assert/strict';
import {secureServiceUrl} from '../src/service-url.ts';
test('Global issuer and public service URL cannot bootstrap remote credentials over HTTP',()=>{
 for(const url of ['https://global.test','http://127.0.0.1:1234','http://[::1]:1234','http://localhost:1234'])assert.equal(secureServiceUrl(url+'/'),url);
 for(const url of ['http://global.test','http://192.168.0.1','http://0.0.0.0','https://user:secret@global.test','https://global.test/?token=secret','https://global.test/#key','file:///tmp/key'])assert.throws(()=>secureServiceUrl(url));
});

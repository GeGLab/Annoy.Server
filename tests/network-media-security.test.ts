import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isPublicAddress,resolvePublicHttps} from '../src/public-https.ts';
test('public network validation blocks mapped IPv6, private, reserved and mixed DNS answers and returns a DNS pin',async()=>{
 for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','100.64.0.1','192.168.1.1','192.0.0.1','224.0.0.1','::1','::ffff:7f00:1','::ffff:a00:1','fc00::1','fe80::1'])assert.equal(isPublicAddress(address),false,address);
 assert.equal(isPublicAddress('2606:4700::1111'),true);assert.equal(isPublicAddress('1.1.1.1'),true);
 for(const url of ['http://example.test/repo','https://user:secret@example.test/repo','https://[::ffff:127.0.0.1]/repo'])await assert.rejects(resolvePublicHttps(url));
 await assert.rejects(resolvePublicHttps('https://example.test/repo',(async()=>[{address:'1.1.1.1',family:4},{address:'127.0.0.1',family:4}]) as any));
 const pinned=await resolvePublicHttps('https://example.test/repo?secret=removed',(async()=>[{address:'1.1.1.1',family:4}]) as any);
 assert.deepEqual(pinned,{url:'https://example.test/repo',resolveEntry:'example.test:443:1.1.1.1'});
});

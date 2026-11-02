import {existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';

const candidates=process.env.ANNOY_CLIENT_TEST_ROOT?[process.env.ANNOY_CLIENT_TEST_ROOT]:['../Annoy.Client','../annoy-client'];
const root=candidates.map(path=>resolve(path)).find(path=>existsSync(join(path,'src/main/crypto/vault.ts')));
if(!root)throw new Error('Annoy.Client checkout missing; set ANNOY_CLIENT_TEST_ROOT.');
export const clientModule=(path:string)=>pathToFileURL(join(root,path)).href;
const executable='annoy-crypto'+(process.platform==='win32'?'.exe':'');
export const cryptoBinary=process.env.ANNOY_CRYPTO_BINARY??['release','debug'].map(profile=>join(root,'native/annoy-crypto/target',profile,executable)).find(path=>existsSync(path))??join(root,'native/annoy-crypto/target/release',executable);

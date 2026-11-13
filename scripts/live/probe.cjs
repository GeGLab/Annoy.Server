const fs = require('node:fs');
const path = require('node:path');
const [method = 'status'] = process.argv.slice(2);
const directory = process.env.ANNOY_CONTROL_DIR || '/control';
const auth = fs.readFileSync(path.join(process.env.ANNOY_DATA_DIR || '/data', 'admin.token'), 'utf8').trim();
import('./wire.mjs').then(({ call }) => call(path.join(directory, `sessions-${process.env.ANNOY_SLOT}.sock`), auth, method)).then(result => console.log(JSON.stringify(result)), () => process.exitCode = 1);

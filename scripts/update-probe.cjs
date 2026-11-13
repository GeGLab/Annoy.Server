// Runs inside a slot, including old images. Only built-in Node modules are used.
const fs = require('node:fs');
const [action, ...args] = process.argv.slice(2);
const port = Number(process.env.ANNOY_PORT || 8787);
function connections() {
  let count = 0;
  for (const name of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const rows = fs.readFileSync(name, 'utf8').trim().split('\n').slice(1);
    for (const row of rows) {
      const fields = row.trim().split(/\s+/);
      if (fields[3] !== '01' || parseInt(fields[1].split(':').at(-1), 16) !== port) continue;
      // Health/admin requests are loopback, never a user's proxy connection.
      if (/^(0100007F|00000000000000000000000001000000|0000000000000000FFFF00000100007F):/.test(fields[2])) continue;
      count++;
    }
  }
  try {
    const legacy=JSON.parse(fs.readFileSync((process.env.ANNOY_CONTROL_DIR||'/control')+'/legacy.json','utf8'));
    if(legacy.enabled&&(!process.env.ANNOY_SLOT||process.env.ANNOY_SLOT===legacy.slot))count=Math.max(count,legacy.gatewayConnections||0);
  }catch{}
  return count;
}
function compare(a, b) {
  const parse = v => { const [core, ...rest] = v.replace(/^v/, '').split('+')[0].split('-'); return { core: core.split('.').map(Number), pre: rest.join('-').split('.').filter(Boolean) }; };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i] ? 1 : -1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i]; if (p === q) continue;
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) > Number(q) ? 1 : -1;
    if (pn !== qn) return pn ? -1 : 1;
    return p > q ? 1 : -1;
  }
  return 0;
}
(async () => {
  let output;
  if (action === 'connections') output = connections();
  else if(action==='handoff-phase'){const dir=process.env.ANNOY_CONTROL_DIR||'/control';const state=JSON.parse(fs.readFileSync(dir+'/legacy.json','utf8'));output=state.enabled&&state.forwarded&&fs.readFileSync(dir+'/active','utf8').trim()===state.target?'active_draining':'handoff_recovery';}
  else if (action === 'prepare' || action === 'retire-ready') {
    const token=fs.readFileSync((process.env.ANNOY_DATA_DIR||'/data')+'/admin.token','utf8').trim();
    const response=await fetch(`http://127.0.0.1:${port}/api/admin/host/handoff/${action==='prepare'?'prepare':'retire'}`,{
      method:'POST',headers:{'x-annoy-admin-token':token,'content-type':'application/json',connection:'close'},
      body:JSON.stringify(action==='prepare'?{slot:args[0],target:args[1]}:{}),signal:AbortSignal.timeout(35_000)
    });
    if(!response.ok)throw Error('Handoff unavailable');
    const data=await response.json();output=action==='prepare'?'ready':data.ready?'1':'0';
  }
  else if (action === 'compare') output = compare(args[0], args[1]);
  else if (action === 'health') {
    const response = await fetch(`http://127.0.0.1:${port}/api/info`, { signal: AbortSignal.timeout(3000), headers: { connection: 'close' } });
    if (response.status !== 200) throw Error('health_not_200');
    const info = await response.json();
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(info.version)) throw Error('invalid_version');
    if (args[0] && info.version !== args[0]) throw Error('unexpected_version');
    output = info.version;
  } else throw Error('unknown_probe');
  process.stdout.write(String(output) + '\n', () => process.exit(0));
})().catch(() => process.exit(1));

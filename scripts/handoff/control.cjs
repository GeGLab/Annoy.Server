const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const state=JSON.parse(fs.readFileSync(path.join(process.env.ANNOY_CONTROL_DIR||'/control','legacy.json'),'utf8'));
const openBus=require(state.bundle&&fs.existsSync(path.join(state.bundle,'bus.cjs'))?path.join(state.bundle,'bus.cjs'):'./scripts/handoff/bus.cjs');
const action = process.argv[2];
if (!['activate', 'rollback', 'snapshot', 'close-idle'].includes(action)) throw Error('Invalid handoff command');
(async () => {
  const db = openBus(path.join(process.env.ANNOY_CONTROL_DIR || '/control', 'handoff.sqlite'));
  const id = randomUUID(); db.prepare('INSERT INTO commands(id,action,data,created,generation) VALUES(?,?,?,?,?)').run(id, action, '{}', Date.now(),state.generation||'');
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const row = db.prepare('SELECT status FROM commands WHERE id=?').get(id);
    if (row.status === 'done') { db.close(); process.stdout.write('ok\n', () => process.exit(0)); return; }
    if (row.status === 'failed') throw Error('Handoff command failed');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error('Handoff command timed out');
})().catch(() => { process.stderr.write('Handoff command was not confirmed; the original process was preserved.\n'); process.exit(1); });

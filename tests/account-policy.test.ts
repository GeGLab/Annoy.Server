import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const setup = `
  import assert from 'node:assert/strict';
  import Fastify from 'fastify';
  const { db, run, one } = await import('./src/db.ts');
  const { authRoutes } = await import('./src/routes/auth.ts');
  const { createSession, hashPassword, hashToken, userIdForToken } = await import('./src/auth.ts');
  const { config } = await import('./src/config.ts');
  const { HttpError } = await import('./src/errors.ts');
  const app = Fastify();
  app.setErrorHandler((e, req, reply) => reply.status(e instanceof HttpError ? e.status : 500).send({error:e.code, message:e.message}));
  authRoutes(app);
  const {discordAuthRoutes}=await import('./src/routes/discord-auth.ts'); discordAuthRoutes(app);
  const call = (url, payload, token, method='POST') => app.inject({url, method, payload, headers:token ? {authorization:'Bearer '+token} : {}});
`;
function execute(directory: string, mode: string | undefined, code: string, extra: Record<string, string> = {}) {
  const env = { ...process.env, ANNOY_DATA_DIR: directory, ANNOY_REGISTRATION: "open", ...extra };
  delete env.ANNOY_ACCOUNT_MODE;
  delete env.ANNOY_GLOBAL;
  if (mode) env.ANNOY_ACCOUNT_MODE = mode;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", setup + code + "\nawait app.close(); db.close();"], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout.trim();
}

test("mode changes fail closed across restarts without changing account data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "annoy-account-policy-"));
  try {
    execute(directory, "local", `
      const reg = await call('/auth/register', {username:'alice', password:'local-password'});
      assert.equal(reg.statusCode, 200, reg.body);
      const {user} = reg.json();
      run("UPDATE users SET global_id='preserved-identity' WHERE id=?",user.id);
      run("INSERT INTO servers(id,name,owner_id,created_at) VALUES('s','History',?,'2026-01-01')", user.id);
      run("INSERT INTO members(server_id,user_id,joined_at) VALUES('s',?,'2026-01-01')", user.id);
      run("INSERT INTO channels(id,server_id,type,name,created_at) VALUES('c','s','text','general','2026-01-01')");
      run("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('m','c',?,'kept','2026-01-01')", user.id);
    `);
    const result = spawnSync(process.execPath, ['--import','tsx','--input-type=module','-e',"await import('./src/auth.ts')"], {
      env: {...process.env, ANNOY_DATA_DIR:directory, ANNOY_ACCOUNT_MODE:'global', ANNOY_GLOBAL:undefined}, encoding:'utf8'
    });
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/account_mode_migration_required/);
    execute(directory, "local", `
      assert.equal(one("SELECT global_id FROM users WHERE username='alice'").global_id,'preserved-identity');
      assert.equal(one("SELECT content FROM messages WHERE id='m'").content,'kept');
      assert.equal(one("SELECT value FROM instance_settings WHERE key='auth.accountMode'").value,'local');
      assert.equal(one("SELECT count(*) AS n FROM members").n,1);
      let requests=0;
      globalThis.fetch=async()=>{requests++;throw new Error('offline')};
      const {startGlobal}=await import('./src/global.ts'); startGlobal(()=>{});
      assert.equal((await call('/auth/global/challenge',{})).statusCode,403);
      assert.equal(requests,0);
    `);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test("fresh global deployment blocks local access even when Global is offline", async () => {
  const directory=await mkdtemp(join(tmpdir(),'annoy-global-policy-'));
  try { execute(directory,undefined,`
    assert.equal(config.accountMode,'global');
    assert.equal((await call('/auth/register',{username:'alice',password:'password123'})).statusCode,403);
    assert.equal((await call('/auth/login',{username:'alice',password:'password123'})).statusCode,403);
    assert.equal((await call('/auth/global', {identity:'x',challenge:'x',signature:'x',token:{kid:'x',message:'x',signature:'x'}})).statusCode,503);
    assert.equal(config.accountMode,'global');
  `); } finally { await rm(directory,{recursive:true,force:true}); }
});

test("local enrollment accepts a one-use host recovery code, rejects wrong/expired codes and suspended users", async () => {
  const directory = await mkdtemp(join(tmpdir(), "annoy-account-recovery-"));
  try {
    execute(directory, "local", `
      run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES('u','user','User','!','2026-01-01')");
      const recover = (code, expires) => run("INSERT OR REPLACE INTO account_recovery(user_id,token_hash,expires_at) VALUES('u',?,?)",hashToken(code),expires);
      const migrate = code => call('/auth/migrate/local',{username:'user',recoveryCode:code,newPassword:'safe-local-password'});
      recover('code', new Date(Date.now()+60000).toISOString());
      assert.equal((await migrate('wrong')).statusCode,401);
      recover('expired', '2020-01-01');
      assert.equal((await migrate('expired')).statusCode,401);
      recover('valid', new Date(Date.now()+60000).toISOString());
      run("UPDATE users SET banned_at='2026-01-01' WHERE id='u'");
      assert.equal((await migrate('valid')).statusCode,403);
      run("UPDATE users SET banned_at=NULL WHERE id='u'");
      assert.equal((await migrate('valid')).statusCode,200);
      assert.equal(one("SELECT count(*) AS n FROM account_recovery").n,0);
      assert.equal((await migrate('valid')).statusCode,401);
    `);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("invalid account modes and conflicting legacy flags fail startup", () => {
  for (const [mode, legacy] of [["mixed", undefined], ["global", "off"], ["local", "on"]]) {
    const env = { ...process.env, ANNOY_ACCOUNT_MODE: mode };
    if (legacy) env.ANNOY_GLOBAL = legacy; else delete env.ANNOY_GLOBAL;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "await import('./src/config.ts')"], { env, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ANNOY_ACCOUNT_MODE/);
  }
});

test("passwords use Argon2id, reject malformed hashes, and upgrade legacy passwords only after valid login", async () => {
  const directory=await mkdtemp(join(tmpdir(),'annoy-passwords-'));
  try { execute(directory,'local',`
    const {verifyPassword}=await import('./src/auth.ts');
    const {scryptSync}=await import('node:crypto');
    const salt=Buffer.alloc(16,1);
    const legacy='scrypt$'+salt.toString('base64')+'$'+scryptSync('legacy-password',salt,64).toString('base64');
    run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES('u','alice','Alice',?,'2026-01-01')",legacy);
    assert.equal((await call('/auth/login',{username:'alice',password:'wrong'})).statusCode,401);
    assert.equal(one("SELECT password_hash FROM users WHERE id='u'").password_hash,legacy);
    assert.equal((await call('/auth/login',{username:'alice',password:'legacy-password'})).statusCode,200);
    const hash=one("SELECT password_hash FROM users WHERE id='u'").password_hash;
    assert.ok(hash.startsWith('$argon2id$'));
    assert.equal(await verifyPassword('legacy-password',hash),true);
    assert.equal(await verifyPassword('wrong',hash),false);
    assert.equal(await verifyPassword('x','$argon2id$v=19$m=999999999,t=3,p=1$bad$bad'),false);
    assert.equal(await verifyPassword('x','scrypt$bad$bad'),false);
    assert.notEqual(await hashPassword('same-password'),await hashPassword('same-password'));
  `); } finally { await rm(directory,{recursive:true,force:true}); }
});

test("expired, revoked and legacy sessions cannot access HTTP or migration endpoints", async () => {
  const directory=await mkdtemp(join(tmpdir(),'annoy-sessions-'));
  try { execute(directory,'local',`
    run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES('u','alice','Alice','!','2026-01-01')");
    const token=createSession('u');
    assert.equal(userIdForToken(token),'u');
    run("UPDATE sessions SET expires_at='2020-01-01'");
    assert.equal(userIdForToken(token),null);
    assert.equal((await call('/users/@me',undefined,token,'GET')).statusCode,401);
    assert.equal((await call('/auth/migrate/local',{newPassword:'password123'},token)).statusCode,401);
    run("UPDATE sessions SET expires_at=NULL");
    assert.equal(userIdForToken(token),null);
    const valid=createSession('u'); run("DELETE FROM sessions");
    assert.equal(userIdForToken(valid),null);
  `); } finally { await rm(directory,{recursive:true,force:true}); }
});

test("account attempt limit cannot be bypassed with forged forwarding headers", async () => {
  const directory=await mkdtemp(join(tmpdir(),'annoy-limits-'));
  try { execute(directory,'local',`
    for(let i=0;i<10;i++) {
      const res=await app.inject({method:'POST',url:'/auth/login',payload:{username:'alice',password:'wrong'},headers:{'x-forwarded-for':'10.0.0.'+i}});
      assert.equal(res.statusCode,401,res.body);
    }
    assert.equal((await call('/auth/login',{username:'ALICE',password:'wrong'})).statusCode,429);
  `); } finally { await rm(directory,{recursive:true,force:true}); }
});

test("Discord cannot create independent authentication in either account mode", async () => {
  for (const mode of ['global','local']) {
    const directory=await mkdtemp(join(tmpdir(),'annoy-discord-policy-'));
    try { execute(directory,mode,`
      assert.equal((await call('/auth/discord/begin',{})).statusCode,403);
      assert.equal((await call('/auth/discord/begin',{link:true})).statusCode,401);
      const {beginLogin}=await import('./src/discord/oauth.ts');
      assert.throws(()=>beginLogin('https://example.test',null),/autenticada/);
    `,{ANNOY_DISCORD_CLIENT_ID:'test',ANNOY_DISCORD_CLIENT_SECRET:'test'}); }
    finally {await rm(directory,{recursive:true,force:true});}
  }
});

test("production /api prefix preserves the authentication attempt limit", async () => {
  const directory=await mkdtemp(join(tmpdir(),'annoy-prefix-limits-'));
  try { execute(directory,'local',`
    const production=Fastify();
    production.setErrorHandler((e,req,reply)=>reply.status(e.status??500).send({code:e.code}));
    await production.register(async api=>authRoutes(api),{prefix:'/api'});
    for(let i=0;i<10;i++)assert.equal((await production.inject({method:'POST',url:'/api/auth/login',payload:{username:'prefix-account',password:'wrong'}})).statusCode,401);
    assert.equal((await production.inject({method:'POST',url:'/api/auth/login',payload:{username:'PREFIX-ACCOUNT',password:'wrong'}})).statusCode,429);
    await production.close();
  `); } finally {await rm(directory,{recursive:true,force:true});}
});

test("account merges cannot rewrite historical authorship", async () => {
  const directory=await mkdtemp(join(tmpdir(),'annoy-merge-principals-'));
  try {execute(directory,'local',`
    const {mergeUsers}=await import('./src/accounts.ts');
    for(const id of ['a','b'])run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,'!','2026-01-01')",id,id,id);
    run("INSERT INTO channels(id,type,name,created_at) VALUES('c','dm','history','2026-01-01')");
    run("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('m','c','b','legacy','2026-01-01')");
    assert.throws(()=>mergeUsers('a','b'),/histórico/);
    assert.equal(one("SELECT author_id FROM messages WHERE id='m'").author_id,'b');
    assert.equal(one('SELECT count(*) AS n FROM users').n,2);
  `);}finally{await rm(directory,{recursive:true,force:true});}
});

test("password concurrency rejects overload rather than allocating unbounded KDF work", async () => {
  const directory=await mkdtemp(join(tmpdir(),'annoy-auth-load-'));
  try { execute(directory,'local',`
    const results=await Promise.allSettled(Array.from({length:12},()=>hashPassword('test-password')));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,10);
    assert.ok(results.filter(r=>r.status==='rejected').every(r=>r.reason.status===429));
    assert.ok((await hashPassword('next-password')).startsWith('$argon2id$'));
  `); } finally {await rm(directory,{recursive:true,force:true});}
});

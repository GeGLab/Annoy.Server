import inspector from 'node:inspector';
import { randomUUID } from 'node:crypto';

// One-time compatibility with the two pinned deployed runtimes. New releases
// expose their migration maps explicitly and never use Inspector for handoff.
export async function scopes(fn, names) {
  const session = new inspector.Session(); session.connect();
  const key = `annoy-scope-${randomUUID()}`;
  globalThis[key] = { fn, result: {} };
  const post = (method, params) => new Promise((resolve, reject) => session.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
  try {
    const value = await post('Runtime.evaluate', { expression: `globalThis[${JSON.stringify(key)}].fn` });
    const properties = await post('Runtime.getProperties', { objectId: value.result.objectId });
    const list = properties.internalProperties.find(p => p.name === '[[Scopes]]')?.value?.objectId;
    if (!list) throw Error('Compatibility scopes unavailable');
    const entries = await post('Runtime.getProperties', { objectId: list, ownProperties: true });
    for (const entry of entries.result.filter(p => /^\d+$/.test(p.name))) {
      const scope = await post('Runtime.getProperties', { objectId: entry.value.objectId, ownProperties: true });
      for (const property of scope.result) if (names.includes(property.name) && property.value?.objectId) {
        await post('Runtime.callFunctionOn', { objectId: property.value.objectId, functionDeclaration: `function(){globalThis[${JSON.stringify(key)}].result[${JSON.stringify(property.name)}]=this;}` });
      }
    }
    const result = globalThis[key].result;
    for (const name of names) if (!(name in result)) throw Error(`Compatibility state unavailable: ${name}`);
    return result;
  } finally { delete globalThis[key]; session.disconnect(); }
}

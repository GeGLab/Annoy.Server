import net from 'node:net';
import { randomUUID } from 'node:crypto';

// Private Unix sockets only. A bounded line reader also preserves bytes after
// the control prelude when a channel becomes a raw WebSocket stream.
export function channel(socket) {
  let buffer = Buffer.alloc(0), ended = false;
  const waiting = [], lines = [];
  const fail = error => { ended = true; for (const w of waiting.splice(0)) w.reject(error); };
  const receive = data => {
    buffer = Buffer.concat([buffer, data]);
    if (buffer.length > 1024 * 1024) return socket.destroy(Error('Control frame too large'));
    let at;
    while ((at = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0, at).toString(); buffer = buffer.subarray(at + 1);
      const w = waiting.shift(); if (w) w.resolve(line); else lines.push(line);
      // Raw frames after the last awaited prelude must never be parsed as JSON.
      if (!waiting.length) break;
    }
  };
  socket.on('data', receive);
  socket.on('error', fail); socket.on('close', () => fail(Error('Control channel closed')));
  return {
    socket,
    send(value) { socket.write(JSON.stringify(value) + '\n'); },
    async read(timeout = 8000) {
      if (lines.length) return JSON.parse(lines.shift());
      if (ended) throw Error('Control channel closed');
      const at = buffer.indexOf(10);
      if (at >= 0) { const line = buffer.subarray(0, at).toString(); buffer = buffer.subarray(at + 1); return JSON.parse(line); }
      let entry;
      const promise = new Promise((resolve, reject) => { entry = { resolve, reject }; waiting.push(entry); });
      const timer = setTimeout(() => { const i = waiting.indexOf(entry); if (i >= 0) waiting.splice(i, 1); entry.reject(Error('Control deadline exceeded')); }, timeout);
      try { return JSON.parse(await promise); } finally { clearTimeout(timer); }
    },
    release() {
      socket.pause(); socket.off('data', receive);
      if (buffer.length) socket.unshift(buffer);
      buffer = Buffer.alloc(0);
      return socket;
    },
  };
}

export async function connect(path) {
  const socket = net.connect(path);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  return channel(socket);
}

export async function call(path, auth, method, data = {}) {
  const peer = await connect(path);
  try {
    peer.send({ id: randomUUID(), auth, method, data });
    const response = await peer.read(30_000);
    if (!response.ok) throw Error(response.error || 'Private operation failed');
    return response.result;
  } finally { peer.socket.destroy(); }
}

export function serve(socket, handler) {
  const peer = channel(socket);
  void (async () => {
    try {
      while (!socket.destroyed) {
        const message = await peer.read(120_000);
        try { peer.send({ id: message.id, ok: true, result: await handler(message) }); }
        catch (error) { peer.send({ id: message.id, ok: false, error: error.message }); }
      }
    } catch { socket.destroy(); }
  })();
}

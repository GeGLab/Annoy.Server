import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Standby must not clean temporary rooms or synchronize memberships owned by the active process. */
export function whenServing(start: () => void): void {
  const slot = process.env.ANNOY_SLOT;
  const directory = process.env.ANNOY_CONTROL_DIR;
  if (!slot || !directory) { start(); return; }
  const serving = () => { try { return readFileSync(join(directory, 'active'), 'utf8').trim() === slot; } catch { return slot === 'annoy'; } };
  if (serving()) { start(); return; }
  const timer = setInterval(() => { if (serving()) { clearInterval(timer); start(); } }, 500);
  timer.unref();
}

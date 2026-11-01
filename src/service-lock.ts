import {config} from './config.ts';
import {acquireDataLock} from './data-lock.ts';
const release=acquireDataLock(config.dataDir);process.once('exit',release);

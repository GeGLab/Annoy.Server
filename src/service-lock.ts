import { config } from "./config.ts";
import { acquireDataLock } from "./data-lock.ts";
// A service: another service may share the data (blue-green update); an offline migration may not.
const release = acquireDataLock(config.dataDir, "service");
process.once("exit", release);

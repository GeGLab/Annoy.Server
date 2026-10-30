import { readFileSync } from "node:fs";

/** package.json is the only place the server version is written. */
export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

// Background MIB-cache builder. Run as a SEPARATE process by the server so the (potentially slow,
// CPU-bound) parse of a large vendor MIB set never blocks the server's event loop. It parses
// MIB_DIR, quarantines any parser-poisoning files, and writes the distilled cache + skip list into
// MIB_DIR (.switchkeeper-cache.json / .switchkeeper-skip). The server then serves from that cache.
//
// Usage: node build-mib-cache.ts <MIB_DIR> [STD_MIB_DIR]
import { createMibStore } from "../../engine/src/index.ts";

const mibDir = process.argv[2];
const stdDir = process.argv[3];
if (!mibDir) {
  console.error("[mib-build] usage: build-mib-cache.ts <MIB_DIR> [STD_MIB_DIR]");
  process.exit(2);
}
const t0 = Date.now();
const store = createMibStore();
if (stdDir) {
  try { store.indexDir(stdDir); } catch { /* no std bundle */ }
}
const r = store.loadDir(mibDir); // cold build: parse, quarantine poisons, write cache + skip
console.error(`[mib-build] loaded ${r.loaded}, skipped ${r.skipped.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(0);

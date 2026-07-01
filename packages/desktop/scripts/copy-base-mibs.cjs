#!/usr/bin/env node
// esbuild bundles net-snmp into build/engine.cjs, but net-snmp loads its base MIB modules
// (RFC1155-SMI, SNMPv2-SMI/TC, RFC1213-MIB, IF-MIB, ...) at runtime from
//   __dirname + "/lib/mibs/<MODULE>.mib"
// After bundling, that __dirname is this package's build/ directory, so the base .mib data files
// must be copied to build/lib/mibs/ or any MIB whose IMPORTS reference a base module fails with
// "ENOENT ... build/lib/mibs/RFC1155-SMI.mib" (seen only in packaged Electron builds; the MCP
// server runs net-snmp unbundled from node_modules, where these files already sit).
const fs = require("fs");
const path = require("path");

function findNetSnmpMibDir() {
  // Prefer the resolver (handles npm-workspaces hoisting); fall back to walking up node_modules.
  try {
    const dir = path.join(path.dirname(require.resolve("net-snmp")), "lib", "mibs");
    if (fs.existsSync(dir)) return dir;
  } catch { /* not resolvable from here; try manual walk */ }
  let cur = __dirname;
  for (let i = 0; i < 8; i++) {
    const cand = path.join(cur, "node_modules", "net-snmp", "lib", "mibs");
    if (fs.existsSync(cand)) return cand;
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return null;
}

const src = findNetSnmpMibDir();
if (!src) {
  console.error("[copy-base-mibs] could not locate net-snmp/lib/mibs — base MIB imports will fail in the packaged app");
  process.exit(1);
}
const dst = path.join(__dirname, "..", "build", "lib", "mibs");
fs.mkdirSync(dst, { recursive: true });
let n = 0;
for (const f of fs.readdirSync(src)) {
  if (!f.toLowerCase().endsWith(".mib")) continue;
  fs.copyFileSync(path.join(src, f), path.join(dst, f));
  n++;
}
console.log(`[copy-base-mibs] copied ${n} base MIB file(s) from ${src} -> ${dst}`);

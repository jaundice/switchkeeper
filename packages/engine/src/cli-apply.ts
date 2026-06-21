// Plan/apply CLI used by the desktop and MCP hosts.
//   --host <ip> [--community public] [--write-community private]
//   --edits '<json Edit[]>'  [--dry-run]
// Prints a single JSON object: { mode, changeSet } or { error }.
import { SnmpClient } from "./snmp.ts";
import { probe } from "./capabilities.ts";
import { readState } from "./readState.ts";
import { planChanges, applyChangeSet } from "./apply.ts";
import { saveRunningConfig } from "./save.ts";
import { argOf, credentialFromArgs } from "./cliargs.ts";
import type { Edit } from "./model.ts";

const host = argOf("host");
if (!host) {
  console.log(JSON.stringify({ error: "missing --host" }));
  process.exit(2);
}
const cred = credentialFromArgs();
// v2c needs a write community to write; v3 writes with the same user.
const canWrite = cred.protocol === "snmpV3" || !!cred.writeCommunity;
const dryRun = process.argv.includes("--dry-run") || !canWrite;
let edits: Edit[] = [];
try {
  edits = JSON.parse(argOf("edits", "[]")!);
} catch (e) {
  console.log(JSON.stringify({ error: "bad --edits json: " + (e as Error).message }));
  process.exit(2);
}

const client = new SnmpClient(host, cred);
try {
  const { device, capabilities } = await probe(client, host);
  const state = await readState(client, device, capabilities);
  const cs = planChanges(state, edits);
  if (dryRun) {
    console.log(JSON.stringify({ mode: "plan", changeSet: cs }));
  } else {
    const res = await applyChangeSet(client, state, cs);
    const save = process.argv.includes("--save") ? await saveRunningConfig(client, device) : undefined;
    console.log(JSON.stringify({ mode: "apply", changeSet: res, save }));
  }
} catch (e) {
  console.log(JSON.stringify({ error: (e && (e as Error).message) || String(e) }));
} finally {
  client.close();
}

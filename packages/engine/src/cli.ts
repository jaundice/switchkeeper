// Read-only probe CLI. Run from a host allowed to reach the switch:
//   node packages/engine/src/cli.ts --host 192.168.1.10 --community public [--json]
import { readDevice } from "./index.ts";
import { argOf, credentialFromArgs } from "./cliargs.ts";

async function main() {
  const host = argOf("host");
  if (!host) {
    console.error("usage: cli.ts --host <ip> [--community public | --version v3 --v3-user ...] [--json]");
    process.exit(2);
  }
  const cred = credentialFromArgs();
  const state = await readDevice(host, cred);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  const d = state.device;
  console.log(`Device : ${d.model}`);
  console.log(`Vendor : enterprise ${d.vendorEnterprise} (${d.vendorOid})`);
  console.log(`Caps   : ${JSON.stringify(d.capabilities)}`);
  console.log(`\nVLANs (${state.vlans.length}):`);
  for (const v of state.vlans) {
    console.log(
      `  ${String(v.vid).padStart(4)} ${(v.name ?? "").padEnd(12)} ` +
        `untagged=[${v.members.untagged.join(",")}] tagged=[${v.members.tagged.join(",")}]`,
    );
  }
  const assigned = state.ports.filter((p) => p.kind === "physical");
  console.log(`\nPorts (${assigned.length} physical):`);
  for (const p of assigned) {
    const poe = p.poe?.capable ? ` poe=${p.poe.adminOn ? "on" : "off"}/${p.poe.status}` : "";
    console.log(
      `  ${String(p.ifIndex).padStart(3)} ${p.name.padEnd(10)} ${p.operStatus.padEnd(5)} ` +
        `pvid=${p.pvid ?? "-"} tagged=[${p.taggedVlans.join(",")}]${poe}`,
    );
  }
}

main().catch((e) => {
  console.error("error:", e?.message ?? e);
  process.exit(1);
});

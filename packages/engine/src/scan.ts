// Discovery CLI.
//   node scan.ts --list-ifaces [--json]              list local interfaces + subnets
//   node scan.ts 192.168.1.0/24[,10.0.0.0/24]        scan one or more subnets/ranges
//   node scan.ts --all-ifaces                         scan every non-internal iface subnet
//   [--community public] [--json]
import { discoverMany } from "./discover.ts";
import { listInterfaces } from "./interfaces.ts";
import { profileForEnterprise } from "./profiles.ts";
import { credentialFromArgs } from "./cliargs.ts";

const wantJson = process.argv.includes("--json");
const wantNdjson = process.argv.includes("--ndjson");
const withVendor = (r: { vendorEnterprise?: number }) => ({ ...r, vendor: profileForEnterprise(r.vendorEnterprise).name });

if (process.argv.includes("--list-ifaces")) {
  const ifs = listInterfaces();
  if (wantJson) {
    console.log(JSON.stringify(ifs));
  } else {
    console.log("local interfaces:");
    for (const i of ifs) {
      console.log(`  ${i.name.padEnd(24)} ${i.address.padEnd(15)} ${i.subnet.padEnd(20)} ${i.mac ?? ""}`);
    }
  }
  process.exit(0);
}

const cred = credentialFromArgs();
const credLabel = cred.protocol === "snmpV3" ? `v3 user ${cred.v3?.user ?? ""}` : `community ${cred.readCommunity ?? "public"}`;
let specs: string[];
if (process.argv.includes("--all-ifaces")) {
  specs = listInterfaces().map((i) => i.subnet);
} else {
  const first = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "192.168.1.0/24";
  specs = first.split(",").map((s) => s.trim()).filter(Boolean);
}

console.error(`scanning ${specs.join(", ")} (${credLabel}) ...`);
const results = await discoverMany(specs, {
  credential: cred,
  // Stream each device the moment it is found (one JSON object per line on stdout).
  onFound: wantNdjson ? (d) => process.stdout.write(JSON.stringify(withVendor(d)) + "\n") : undefined,
  onProgress: (done, total, found) => {
    if (done % 32 === 0 || done === total) process.stderr.write(`\r  ${done}/${total} probed, ${found} found   `);
  },
});
process.stderr.write("\n");

if (wantNdjson) {
  process.stdout.write(JSON.stringify({ done: true, count: results.length }) + "\n");
} else if (wantJson) {
  console.log(JSON.stringify(results.map(withVendor)));
} else if (results.length === 0) {
  console.log("no SNMP devices answered.");
} else {
  console.log(`\nfound ${results.length} SNMP device(s):`);
  for (const r of results) {
    console.log(`  ${r.host.padEnd(15)}  [${r.vendorEnterprise ?? "?"}] ${profileForEnterprise(r.vendorEnterprise).name}  ${r.model ?? ""}`);
  }
}

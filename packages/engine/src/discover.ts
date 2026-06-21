// Network discovery: a concurrent SNMP sweep. Sends GET sysObjectID+sysDescr to every
// target; whoever answers is an SNMP agent, and the reply identifies the vendor for free.
import { SnmpClient } from "./snmp.ts";
import { OID, enterpriseFromSysObjectID } from "./oids.ts";
import { asString } from "./util.ts";
import { expandTargets, ipToInt } from "./targets.ts";
import type { Credential, DiscoveryResult } from "./model.ts";

export interface DiscoverOptions {
  community?: string;
  timeoutMs?: number;
  retries?: number;
  concurrency?: number;
  /** Use an explicit credential (e.g. SNMPv3); otherwise v2c with `community`. */
  credential?: Credential;
  /** Called as each host is probed (done/total), for progress UIs. */
  onProgress?: (done: number, total: number, found: number) => void;
  /** Called the moment a device is found, for live/streaming UIs. */
  onFound?: (device: DiscoveryResult) => void;
}

async function probeOne(host: string, cred: Credential, timeoutMs: number, retries: number): Promise<DiscoveryResult | null> {
  const client = new SnmpClient(host, cred, { timeoutMs, retries });
  try {
    const vbs = await client.get([OID.sysObjectID, OID.sysDescr]);
    const sysObjectID = asString(vbs[0]?.value);
    const enterprise = enterpriseFromSysObjectID(sysObjectID);
    const model = vbs[1] ? asString(vbs[1].value) : undefined;
    return {
      host,
      transport: cred.protocol === "snmpV3" ? "snmpV3" : "snmpV2c",
      model,
      vendorEnterprise: enterprise,
    };
  } catch {
    return null; // no/invalid response = not an answering agent for these creds
  } finally {
    client.close();
  }
}

export async function discover(spec: string, opts: DiscoverOptions = {}): Promise<DiscoveryResult[]> {
  const timeoutMs = opts.timeoutMs ?? 1000;
  const retries = opts.retries ?? 0;
  const concurrency = opts.concurrency ?? 64;
  const cred: Credential = opts.credential ?? { protocol: "snmpV2c", readCommunity: opts.community ?? "public" };

  const targets = expandTargets(spec);
  const results: DiscoveryResult[] = [];
  let idx = 0;
  let done = 0;

  async function worker() {
    while (idx < targets.length) {
      const host = targets[idx++];
      const r = await probeOne(host, cred, timeoutMs, retries);
      done++;
      if (r) {
        results.push(r);
        opts.onFound?.(r);
      }
      opts.onProgress?.(done, targets.length, results.length);
    }
  }

  const n = Math.min(concurrency, targets.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  results.sort((a, b) => ipToInt(a.host) - ipToInt(b.host));
  return results;
}

/** Scan several subnets/ranges and merge (de-duped by host). */
export async function discoverMany(specs: string[], opts: DiscoverOptions = {}): Promise<DiscoveryResult[]> {
  const seen = new Map<string, DiscoveryResult>();
  for (const spec of specs) {
    for (const r of await discover(spec, opts)) seen.set(r.host, r);
  }
  return [...seen.values()].sort((a, b) => ipToInt(a.host) - ipToInt(b.host));
}

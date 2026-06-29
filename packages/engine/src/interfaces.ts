// Enumerate the local machine's network interfaces and their IPv4 subnets, so the user can
// pick which interface/subnet(s) to scan for switches.
import os from "node:os";
import { ipToInt, intToIp } from "./targets.ts";

export interface LocalInterface {
  name: string;
  address: string;
  netmask: string;
  cidr: number; // prefix length
  subnet: string; // network/prefix, e.g. 192.168.1.0/24
  mac?: string;
  internal: boolean;
}

export function netmaskToPrefix(mask: string): number {
  return (ipToInt(mask).toString(2).match(/1/g) ?? []).length;
}

export function networkOf(address: string, prefix: number): string {
  const mask = prefix === 0 ? 0 : (~((2 ** (32 - prefix)) - 1)) >>> 0;
  return intToIp((ipToInt(address) & mask) >>> 0);
}

/**
 * The MAC of the local interface whose subnet contains `host` — i.e. the source MAC SNMP traffic
 * to that host egresses with when we're L2-adjacent to it. Lets the SafetyEngine pin the exact
 * management port via the switch's forwarding database (high confidence) instead of guessing from
 * uplink heuristics. Returns undefined when no local interface is on the host's subnet (e.g. the
 * switch is reached over an L3 hop), in which case detection falls back to the heuristic path.
 */
export function localSourceMac(host: string): string | undefined {
  let target: number;
  try { target = ipToInt(host); } catch { return undefined; }
  for (const i of listInterfaces({ includeInternal: false })) {
    if (!i.mac || i.mac === "00:00:00:00:00:00") continue;
    const prefix = i.cidr || netmaskToPrefix(i.netmask);
    const mask = prefix === 0 ? 0 : (~((2 ** (32 - prefix)) - 1)) >>> 0;
    if (((target & mask) >>> 0) === ((ipToInt(i.address) & mask) >>> 0)) return i.mac.toLowerCase();
  }
  return undefined;
}

export function listInterfaces(opts: { includeInternal?: boolean } = {}): LocalInterface[] {
  const out: LocalInterface[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      const isV4 = a.family === "IPv4" || (a.family as unknown as number) === 4;
      if (!isV4) continue;
      if (a.internal && !opts.includeInternal) continue;
      const prefix = a.cidr ? Number(a.cidr.split("/")[1]) : netmaskToPrefix(a.netmask);
      out.push({
        name,
        address: a.address,
        netmask: a.netmask,
        cidr: prefix,
        subnet: `${networkOf(a.address, prefix)}/${prefix}`,
        mac: a.mac,
        internal: !!a.internal,
      });
    }
  }
  return out;
}

// Read-only topology helpers: LLDP neighbours and the forwarding database (MAC -> port).
// These make uplink/trunk discovery possible (a port with many MACs is an uplink; LLDP names
// the neighbour directly) instead of physically toggling links.
import type { SnmpClient } from "./snmp.ts";
import { asString, asInt, asBuffer } from "./snmp.ts";
import { OID } from "./oids.ts";
import type { FdbEntry, LldpNeighbor } from "./model.ts";

/** The last 6 sub-identifiers of an FDB table index are the MAC address. */
export function macFromIndexTail(parts: number[]): string {
  return parts.slice(-6).map((b) => (b & 0xff).toString(16).padStart(2, "0")).join(":");
}

/** lldpRemTable index = lldpRemTimeMark . lldpRemLocalPortNum . lldpRemIndex -> local port num. */
export function lldpLocalPortFromIndex(idx: string): number {
  const parts = idx.split(".");
  return parts.length >= 2 ? Number(parts[parts.length - 2]) : Number(parts[0]);
}

export async function readFdb(client: SnmpClient): Promise<FdbEntry[]> {
  const out: FdbEntry[] = [];
  // Q-BRIDGE FDB first (index = fdbId . <6 mac octets>).
  const q = await client.column(OID.dot1qTpFdbPort);
  if (q.size > 0) {
    for (const [idx, vb] of q) {
      const parts = idx.split(".").map(Number);
      if (parts.length < 7) continue;
      out.push({ vlan: parts[0], mac: macFromIndexTail(parts), bridgePort: asInt(vb.value) });
    }
    return out;
  }
  // Fallback: BRIDGE-MIB FDB (index = <6 mac octets>).
  const d = await client.column(OID.dot1dTpFdbPort);
  for (const [idx, vb] of d) {
    const parts = idx.split(".").map(Number);
    if (parts.length < 6) continue;
    out.push({ mac: macFromIndexTail(parts), bridgePort: asInt(vb.value) });
  }
  return out;
}

export async function readLldpNeighbors(client: SnmpClient): Promise<LldpNeighbor[]> {
  const [sys, pid, pdesc, chassis] = await Promise.all([
    client.column(OID.lldpRemSysName),
    client.column(OID.lldpRemPortId),
    client.column(OID.lldpRemPortDesc),
    client.column(OID.lldpRemChassisId),
  ]);
  const out: LldpNeighbor[] = [];
  for (const [idx, vb] of sys) {
    const get = (m: Map<string, { value: unknown }>) => m.get(idx)?.value;
    out.push({
      localPort: lldpLocalPortFromIndex(idx),
      remoteSysName: asString(vb.value) || undefined,
      remotePortId: textOrHex(get(pid)),
      remotePortDesc: asString(get(pdesc)) || undefined,
      remoteChassisId: textOrHex(get(chassis)),
    });
  }
  return out;
}

/** Render an OctetString as text if printable, else as colon-hex (MAC-style). */
export function textOrHex(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = asString(v);
  if (s && /^[\x20-\x7e]+$/.test(s)) return s;
  const b = asBuffer(v);
  return b && b.length ? [...b].map((x) => x.toString(16).padStart(2, "0")).join(":") : undefined;
}

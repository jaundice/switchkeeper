// Build a full, vendor-neutral DeviceState from standard MIBs. Read-only.
import type { SnmpClient } from "./snmp.ts";
import { asString, asInt, asBuffer } from "./snmp.ts";
import type { Capabilities, Device, DeviceState, Lag, Port, PortKind, Vlan, IfStatus, PoePort, PoeStatus } from "./model.ts";
import { OID, PETH_DETECTION } from "./oids.ts";
import { decodePortList } from "./portlist.ts";

const IF_STATUS: Record<number, IfStatus> = { 1: "up", 2: "down", 3: "testing" };

export async function readState(
  client: SnmpClient,
  device: Device,
  caps: Capabilities,
): Promise<DeviceState> {
  // --- bridge-port -> ifIndex map (and its inverse) ---
  const basePortCol = await client.column(OID.dot1dBasePortIfIndex);
  const bridgeToIf = new Map<number, number>();
  const ifToBridge = new Map<number, number>();
  for (const [idx, vb] of basePortCol) {
    const bridgePort = Number(idx);
    const ifIndex = asInt(vb.value);
    bridgeToIf.set(bridgePort, ifIndex);
    ifToBridge.set(ifIndex, bridgePort);
  }

  // --- interface columns ---
  const [names, descrs, types, oper, admin, hspeed, alias, pvid] = await Promise.all([
    client.column(OID.ifName),
    client.column(OID.ifDescr),
    client.column(OID.ifType),
    client.column(OID.ifOperStatus),
    client.column(OID.ifAdminStatus),
    client.column(OID.ifHighSpeed),
    client.column(OID.ifAlias),
    client.column(OID.dot1qPvid),
  ]);

  // --- PoE columns (optional) ---
  let poeAdmin = new Map<string, any>();
  let poeDetect = new Map<string, any>();
  let poeClass = new Map<string, any>();
  if (caps.poe) {
    [poeAdmin, poeDetect, poeClass] = await Promise.all([
      client.column(OID.pethPsePortAdminEnable),
      client.column(OID.pethPsePortDetectionStatus),
      client.column(OID.pethPsePortPowerClassifications),
    ]);
  }

  // --- VLANs: names + live membership from the current table ---
  const vlanNames = await client.column(OID.dot1qVlanStaticName);
  const curEgress = caps.qbridgeRead ? await client.column(OID.dot1qVlanCurrentEgressPorts) : new Map();
  const curUntagged = caps.qbridgeRead ? await client.column(OID.dot1qVlanCurrentUntaggedPorts) : new Map();

  // current-table index is "<timeMark>.<vid>"; reduce to vid -> bitmap
  const egressByVid = lastByVid(curEgress);
  const untaggedByVid = lastByVid(curUntagged);

  const vlans: Vlan[] = [];
  const taggedByBridgePort = new Map<number, Set<number>>();
  const vids = new Set<number>([
    ...[...vlanNames.keys()].map(Number),
    ...egressByVid.keys(),
  ]);
  for (const vid of [...vids].sort((a, b) => a - b)) {
    const egressBuf = egressByVid.get(vid);
    const untaggedBuf = untaggedByVid.get(vid);
    const egress = egressBuf ? decodePortList(egressBuf) : [];
    const untagged = untaggedBuf ? decodePortList(untaggedBuf) : [];
    const untaggedSet = new Set(untagged);
    const tagged = egress.filter((p) => !untaggedSet.has(p));
    for (const p of tagged) {
      if (!taggedByBridgePort.has(p)) taggedByBridgePort.set(p, new Set());
      taggedByBridgePort.get(p)!.add(vid);
    }
    const nameVb = vlanNames.get(String(vid));
    vlans.push({
      vid,
      name: nameVb ? asString(nameVb.value) : undefined,
      members: { tagged, untagged },
      active: true,
      source: caps.membershipSource,
    });
  }

  // --- assemble ports (only real L2 bridge ports: physical 1-48 + LAGs 1000+,
  //     never routed VLAN SVIs / CPU interfaces, which have no bridge port) ---
  const ports: Port[] = [];
  for (const [bridgePort, ifIndex] of bridgeToIf) {
    const ifIdxStr = String(ifIndex);
    const name = asString((names.get(ifIdxStr) ?? descrs.get(ifIdxStr))?.value ?? `if${ifIndex}`);
    const kind: PortKind = bridgePort >= 1000 ? "lag" : "physical";
    const pvidVal = pvid.has(String(bridgePort))
      ? asInt(pvid.get(String(bridgePort))!.value)
      : undefined;
    const aliasVb = alias.get(ifIdxStr);
    const port: Port = {
      ifIndex,
      bridgePort,
      name,
      label: aliasVb && asString(aliasVb.value) ? asString(aliasVb.value) : undefined,
      kind,
      adminStatus: statusOf(admin.get(ifIdxStr)?.value),
      operStatus: statusOf(oper.get(ifIdxStr)?.value),
      speedMbps: hspeed.has(ifIdxStr) ? asInt(hspeed.get(ifIdxStr)!.value) : undefined,
      pvid: pvidVal,
      untaggedVlan: pvidVal,
      taggedVlans: [...(taggedByBridgePort.get(bridgePort) ?? [])].sort((a, b) => a - b),
    };
    if (caps.poe) port.poe = readPoe(String(bridgePort), poeAdmin, poeDetect, poeClass);
    ports.push(port);
  }
  ports.sort((a, b) => a.ifIndex - b.ifIndex);

  // --- LAG (link aggregation) membership, IEEE8023-LAG-MIB (optional) ---
  const lags: Lag[] = [];
  try {
    const lagCol = await client.column(OID.dot3adAggPortListPorts);
    for (const [idx, vb] of lagCol) {
      const aggId = Number(idx);
      const members = decodePortList(asBuffer(vb.value));
      if (members.length > 0) {
        lags.push({ id: aggId, members, mode: "unknown" });
        for (const m of members) {
          const port = ports.find((p) => p.bridgePort === m);
          if (port) port.lagId = aggId;
        }
      }
    }
  } catch { /* LAG MIB not implemented */ }

  return { device, ports, vlans, lags, readAt: new Date().toISOString() };
}

function statusOf(v: unknown): IfStatus {
  return v === undefined ? "unknown" : (IF_STATUS[asInt(v)] ?? "unknown");
}

/** Current-table rows are indexed "<timeMark>.<vid>"; keep the latest bitmap per vid. */
function lastByVid(col: Map<string, any>): Map<number, Uint8Array> {
  const out = new Map<number, Uint8Array>();
  for (const [idx, vb] of col) {
    const parts = idx.split(".");
    const vid = Number(parts[parts.length - 1]);
    out.set(vid, asBuffer(vb.value));
  }
  return out;
}

function readPoe(
  bridgePort: string,
  admin: Map<string, any>,
  detect: Map<string, any>,
  cls: Map<string, any>,
): PoePort {
  // PoE table is indexed by group.port; match on a suffix ".<bridgePort>".
  const find = (m: Map<string, any>) => {
    for (const [k, v] of m) if (k.endsWith("." + bridgePort) || k === bridgePort) return v;
    return undefined;
  };
  const a = find(admin);
  if (!a) return { capable: false };
  const d = find(detect);
  const c = find(cls);
  return {
    capable: true,
    adminOn: asInt(a.value) === 1,
    status: d ? ((PETH_DETECTION[asInt(d.value)] ?? "unknown") as PoeStatus) : "unknown",
    class: c ? asInt(c.value) : undefined,
  };
}

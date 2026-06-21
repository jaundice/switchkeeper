// Connect-time probe: identify the device and discover what it can actually do.
import type { SnmpClient } from "./snmp.ts";
import { asString, asBuffer } from "./snmp.ts";
import type { Capabilities, Device } from "./model.ts";
import { OID, enterpriseFromSysObjectID } from "./oids.ts";
import { profileForEnterprise } from "./profiles.ts";

export async function probe(
  client: SnmpClient,
  host: string,
): Promise<{ device: Device; capabilities: Capabilities }> {
  const [descrVb, oidVb, nameVb] = await client.get([
    OID.sysDescr,
    OID.sysObjectID,
    OID.sysName,
  ]);

  const sysObjectID = asString(oidVb.value);
  const enterprise = enterpriseFromSysObjectID(sysObjectID);
  const profile = profileForEnterprise(enterprise);

  // Port count from ifNumber (best-effort).
  let portCount: number | undefined;
  try {
    const [ifn] = await client.get([OID.ifNumber]);
    portCount = Number(ifn.value);
  } catch { /* leave undefined */ }

  // Determine PortList width + whether live membership is visible, from the current table.
  let portListWidth = portCount ? Math.ceil(portCount / 8) : 32;
  let membershipSource: Capabilities["membershipSource"] = "current";
  let qbridgeRead = false;
  try {
    const cur = await client.column(OID.dot1qVlanCurrentEgressPorts);
    qbridgeRead = cur.size > 0;
    const first = cur.values().next().value;
    if (first) portListWidth = asBuffer(first.value).length;
    const anyNonEmpty = [...cur.values()].some((vb) =>
      asBuffer(vb.value).some((b) => b !== 0),
    );
    membershipSource = anyNonEmpty ? "current" : "static";
  } catch { /* qbridge may be absent */ }

  // PoE: present if the peth admin column answers.
  let poe = false;
  try {
    const pse = await client.column(OID.pethPsePortAdminEnable);
    poe = pse.size > 0;
  } catch { /* no PoE MIB on this device */ }

  // Max VLANs (best-effort).
  let maxVlans: number | undefined;
  try {
    const [mv] = await client.get([OID.dot1qMaxSupportedVlans]);
    maxVlans = Number(mv.value);
  } catch { /* ignore */ }

  const capabilities: Capabilities = {
    qbridgeRead,
    // Writes are gated by the vendor profile; "unknown" until a test proves it.
    qbridgeWrite: profile.vlanWritePath === "standard",
    pvidWrite: profile.pvidWritable,
    canCreateVlan: profile.canCreateVlan,
    canEditLag: profile.canEditLag,
    poe,
    lldp: false,
    lag: true,
    maxVlans,
    portListWidth,
    membershipSource,
  };

  const device: Device = {
    id: host,
    host,
    transport: "snmpV2c",
    vendorOid: sysObjectID,
    vendorEnterprise: enterprise,
    model: asString(descrVb.value),
    sysName: asString(nameVb.value) || undefined,
    portCount,
    capabilities,
    reachable: true,
    lastSeen: new Date().toISOString(),
  };

  return { device, capabilities };
}

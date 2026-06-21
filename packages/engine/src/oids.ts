// Standard IETF MIB OIDs. These cover ~90% of what the app needs on any SNMP smart switch.
// Vendor-specific OIDs live in the vendor profiles (profiles.ts), not here.

export const OID = {
  // SNMPv2-MIB (system)
  sysDescr: "1.3.6.1.2.1.1.1.0",
  sysObjectID: "1.3.6.1.2.1.1.2.0",
  sysName: "1.3.6.1.2.1.1.5.0",

  // IF-MIB
  ifNumber: "1.3.6.1.2.1.2.1.0",
  ifDescr: "1.3.6.1.2.1.2.2.1.2",
  ifType: "1.3.6.1.2.1.2.2.1.3",
  ifSpeed: "1.3.6.1.2.1.2.2.1.5",
  ifAdminStatus: "1.3.6.1.2.1.2.2.1.7",
  ifOperStatus: "1.3.6.1.2.1.2.2.1.8",
  ifName: "1.3.6.1.2.1.31.1.1.1.1",
  ifHighSpeed: "1.3.6.1.2.1.31.1.1.1.15",
  ifAlias: "1.3.6.1.2.1.31.1.1.1.18",

  // BRIDGE-MIB
  dot1dBasePortIfIndex: "1.3.6.1.2.1.17.1.4.1.2",

  // Q-BRIDGE-MIB (RFC 2674 / 4363)
  dot1qVlanVersionNumber: "1.3.6.1.2.1.17.7.1.1.1.0",
  dot1qMaxVlanId: "1.3.6.1.2.1.17.7.1.1.2.0",
  dot1qMaxSupportedVlans: "1.3.6.1.2.1.17.7.1.1.3.0",
  dot1qNumVlans: "1.3.6.1.2.1.17.7.1.1.4.0",
  // Current table (read-only, reflects live state)
  dot1qVlanCurrentEgressPorts: "1.3.6.1.2.1.17.7.1.4.2.1.4",
  dot1qVlanCurrentUntaggedPorts: "1.3.6.1.2.1.17.7.1.4.2.1.5",
  dot1qVlanStatus: "1.3.6.1.2.1.17.7.1.4.2.1.6",
  // Static table (config; writable on compliant devices)
  dot1qVlanStaticName: "1.3.6.1.2.1.17.7.1.4.3.1.1",
  dot1qVlanStaticEgressPorts: "1.3.6.1.2.1.17.7.1.4.3.1.2",
  dot1qVlanForbiddenEgressPorts: "1.3.6.1.2.1.17.7.1.4.3.1.3",
  dot1qVlanStaticUntaggedPorts: "1.3.6.1.2.1.17.7.1.4.3.1.4",
  dot1qVlanStaticRowStatus: "1.3.6.1.2.1.17.7.1.4.3.1.5",
  // Per-port PVID
  dot1qPvid: "1.3.6.1.2.1.17.7.1.4.5.1.1",

  // POWER-ETHERNET-MIB (RFC 3621)
  pethPsePortAdminEnable: "1.3.6.1.2.1.105.1.1.1.3",
  pethPsePortPowerPriority: "1.3.6.1.2.1.105.1.1.1.7",
  pethPsePortDetectionStatus: "1.3.6.1.2.1.105.1.1.1.6",
  pethPsePortPowerClassifications: "1.3.6.1.2.1.105.1.1.1.10",

  // LLDP-MIB (optional, topology)
  lldpLocSysName: "1.0.8802.1.1.2.1.3.3.0",

  // IEEE8023-LAG-MIB: per-aggregator member PortList (which physical ports are in each LAG)
  dot3adAggPortListPorts: "1.2.840.10006.300.43.1.1.2.1.1",
} as const;

// RowStatus values (SNMPv2-TC)
export const RowStatus = {
  active: 1,
  notInService: 2,
  notReady: 3,
  createAndGo: 4,
  createAndWait: 5,
  destroy: 6,
} as const;

// pethPsePortDetectionStatus enum -> PoeStatus
export const PETH_DETECTION: Record<number, string> = {
  1: "disabled",
  2: "searching",
  3: "deliveringPower",
  4: "fault",
  5: "test",
  6: "otherFault",
};

/** Parse the enterprise number out of a sysObjectID like 1.3.6.1.4.1.4526.100.4.11 -> 4526. */
export function enterpriseFromSysObjectID(oid: string): number | undefined {
  const m = oid.match(/^\.?1\.3\.6\.1\.4\.1\.(\d+)/);
  return m ? Number(m[1]) : undefined;
}

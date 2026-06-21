// Vendor quirk profiles. Keyed on the SNMP enterprise number (from sysObjectID).
// The standard-MIB core works on any compliant switch; a profile only overrides the
// few things a vendor/model does differently — chiefly the VLAN write path.

export interface VendorProfile {
  enterprise: number;
  name: string;
  /**
   * "standard" => write VLAN membership via dot1qVlanStaticEgressPorts/UntaggedPorts.
   * "private"  => the model ignores standard writes; use the vendor private MIB.
   * "unknown"  => not yet proven; treat writes as experimental until a test confirms.
   */
  vlanWritePath: "standard" | "private" | "unknown";
  pvidWritable: boolean;
  /** Can a new VLAN be created over SNMP (RowStatus createAndGo/Wait)? */
  canCreateVlan: boolean;
  /** Can LAG membership be edited over SNMP? (vendor-specific; often not) */
  canEditLag: boolean;
  /** Some vendors need an explicit "save running config" write to persist changes. */
  saveConfigOid?: string;
  saveConfigValue?: number;
  /** Shown when no saveConfigOid is known for the model (instead of guessing a write). */
  saveConfigNote?: string;
  notes?: string;
}

const NETGEAR: VendorProfile = {
  enterprise: 4526,
  name: "Netgear (ProSAFE/Smart)",
  // Confirmed on a GS748TP (2026-06-21): standard dot1qPvid write took and read back
  // cleanly (1 -> 10 -> 1) from the permitted SNMP source. Standard write path it is.
  vlanWritePath: "standard",
  pvidWritable: true,
  // Field-confirmed (gs748-field-notes.md): create VLAN over SNMP FAILS
  // (RowStatus createAndGo/createAndWait both inconsistentValue). VLAN must pre-exist.
  canCreateVlan: false,
  // LAG config OID unconfirmed on this Marvell model; dot3adAggPortListPorts is read-only.
  // Likely dot3adAggPortActorAdminKey (.43.1.2.1.1.4) groups ports - test out of production.
  canEditLag: false,
  // No confirmed SNMP save object: this is a Marvell-ROS smart switch (private tree shows
  // rl*/rs* config registry under 4526.17.29), not Broadcom FASTPATH (4526.10). Don't guess.
  saveConfigNote:
    "This Netgear smart switch (Marvell-based) exposes no confirmed SNMP save-config object. " +
    "SNMP changes may persist automatically; to be sure they survive a reboot, use the switch " +
    "web UI: Maintenance > Save Configuration. (A save OID can be added here if one is confirmed.)",
  notes:
    "GS748TP fw V5.2.0.11. Reads + PoE standard. dot1qPvid + membership writes (egress/untagged) " +
    "confirmed on EXISTING VLAN rows. VLAN CREATE over SNMP is unsupported - create the VLAN ID in " +
    "the switch UI first, then assign ports. PortList writes must be 6 or full 126 bytes (odd " +
    "lengths -> wrongLength); engine pads to portListWidth. Write community is source-locked to " +
    "the management station. Writes land in running config; persistence/save OID is TBD.",
};

const GENERIC: VendorProfile = {
  enterprise: -1,
  name: "Generic SNMP smart switch",
  vlanWritePath: "standard",
  pvidWritable: true,
  canCreateVlan: true,
  canEditLag: false,
  notes: "Default: assume RFC 2674 compliant. Overridden once a vendor profile is known.",
};

const REGISTRY = new Map<number, VendorProfile>([[NETGEAR.enterprise, NETGEAR]]);

export function profileForEnterprise(enterprise: number | undefined): VendorProfile {
  if (enterprise === undefined) return GENERIC;
  return REGISTRY.get(enterprise) ?? { ...GENERIC, enterprise };
}

export function registerProfile(p: VendorProfile): void {
  REGISTRY.set(p.enterprise, p);
}

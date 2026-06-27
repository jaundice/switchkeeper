// Vendor quirk profiles. Keyed on the SNMP enterprise number (from sysObjectID).
// The standard-MIB core works on any compliant switch; a profile only overrides the
// few things a vendor/model does differently — chiefly the VLAN write path.
import { OID } from "./oids.ts";

/** How a model persists running config to startup over SNMP (no standard object exists). */
export type SaveMethod =
  | { kind: "trigger"; oid: string; value?: number } // set a scalar to commit
  | { kind: "copyRunningToStartup"; baseOid: string }; // RADLAN-COPY-MIB rlCopyEntry base

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
  /** Preferred structured save method (overrides saveConfigOid when set). */
  save?: SaveMethod;
  /** Shown when no save method is known for the model (instead of guessing a write). */
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
  // Marvell/Radlan stack -> RADLAN-COPY-MIB rlCopy table saves running->startup. This is the
  // documented Radlan base (enterprises.89.87); if this GS748 grafts the rl* tree under its own
  // enterprise (4526.17.29.*) instead, change baseOid accordingly. A wrong OID just errors
  // harmlessly (noSuchName), so attempting it is safe; saveRunningConfig reports the result.
  save: { kind: "copyRunningToStartup", baseOid: OID.rlCopyEntryBase },
  saveConfigNote:
    "Netgear smart switch (Marvell/Radlan). Save uses the RADLAN-COPY-MIB rlCopy table " +
    "(running->startup). If save reports an error, the rl* tree may sit under 4526.17.29 on " +
    "this model - confirm the prefix on the bench and update the profile baseOid.",
  notes:
    "GS748TP fw V5.2.0.11. Reads + PoE standard. dot1qPvid + membership writes (egress/untagged) " +
    "confirmed on EXISTING VLAN rows. VLAN CREATE over SNMP is unsupported - create the VLAN ID in " +
    "the switch UI first, then assign ports. PortList writes must be 6 or full 126 bytes (odd " +
    "lengths -> wrongLength); engine pads to portListWidth. Write community is source-locked to " +
    "the management station. Writes land in running config; persistence/save OID is TBD.",
};

const EXTREME: VendorProfile = {
  enterprise: 1916,
  name: "Extreme Networks (EXOS)",
  // Field-confirmed on an X450G2 (EXOS 30.5): standard Q-BRIDGE createVlan + membership writes
  // land and persist. Empty VLANs are absent from dot1qVlanCurrentTable, so VLAN verify falls
  // back to the static table (handled in apply.ts).
  vlanWritePath: "standard",
  pvidWritable: true,
  canCreateVlan: true,
  // EXOS "sharing" (LAG) groups need the EXTREME private MIB; SNMP LAG write not yet wired.
  canEditLag: false,
  notes:
    "Extreme X450/X465 (EXOS). Standard create/membership writes verified. Empty VLANs don't " +
    "appear in the current table (verify uses the static table). LAG read via IEEE8023-LAG-MIB; " +
    "LAG write needs the EXTREME private MIB (read-only for now).",
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

const REGISTRY = new Map<number, VendorProfile>([
  [NETGEAR.enterprise, NETGEAR],
  [EXTREME.enterprise, EXTREME],
]);

export function profileForEnterprise(enterprise: number | undefined): VendorProfile {
  if (enterprise === undefined) return GENERIC;
  return REGISTRY.get(enterprise) ?? { ...GENERIC, enterprise };
}

export function registerProfile(p: VendorProfile): void {
  REGISTRY.set(p.enterprise, p);
}

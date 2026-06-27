// Switchkeeper data model. Vendor-agnostic, transport-agnostic.
// Membership is always stored as port sets; the PortList bitmap is an internal codec
// (see portlist.ts) parameterised by Capabilities.portListWidth.

export type TransportKind = "snmpV2c" | "snmpV3" | "nsdp";

export interface Credential {
  protocol: TransportKind;
  /** SNMP v2c */
  readCommunity?: string;
  writeCommunity?: string;
  /** SNMP v3 */
  v3?: {
    user: string;
    authProtocol?: "md5" | "sha";
    authKey?: string;
    privProtocol?: "des" | "aes";
    privKey?: string;
  };
  /** NSDP (Netgear) */
  nsdpPassword?: string;
}

/** Capabilities are *discovered* at connect time, never assumed. */
export interface Capabilities {
  qbridgeRead: boolean;
  qbridgeWrite: boolean;
  pvidWrite: boolean;
  poe: boolean;
  lldp: boolean;
  lag: boolean;
  /** Whether new VLANs can be created over SNMP (RowStatus). Some models reject this. */
  canCreateVlan: boolean;
  /** Whether LAG membership can be edited over SNMP (vendor-specific; often not). */
  canEditLag: boolean;
  maxVlans?: number;
  /** Width in bytes of the IETF PortList bitmaps this device returns. */
  portListWidth: number;
  /** Where live VLAN membership is readable from on this model. */
  membershipSource: "static" | "current" | "private";
}

export interface Device {
  id: string;
  host: string;
  transport: TransportKind;
  credentialRef?: string;
  vendorOid?: string; // sysObjectID
  vendorEnterprise?: number; // e.g. 4526 = Netgear
  model?: string; // sysDescr
  firmware?: string;
  sysName?: string;
  baseMac?: string;
  portCount?: number;
  capabilities?: Capabilities;
  reachable: boolean;
  lastSeen?: string; // ISO
}

export type PortKind = "physical" | "lag";
export type IfStatus = "up" | "down" | "testing" | "unknown";
export type PoeStatus =
  | "disabled"
  | "searching"
  | "deliveringPower"
  | "fault"
  | "test"
  | "otherFault"
  | "unknown";

export interface PoePort {
  capable: boolean;
  adminOn?: boolean;
  status?: PoeStatus;
  class?: number;
  watts?: number;
  priority?: "critical" | "high" | "low" | "unknown";
}

export interface Port {
  ifIndex: number;
  bridgePort?: number; // dot1dBasePort
  name: string; // ifName/ifDescr
  label?: string; // user alias (ifAlias)
  kind: PortKind;
  adminStatus: IfStatus;
  operStatus: IfStatus;
  speedMbps?: number;
  pvid?: number;
  untaggedVlan?: number;
  taggedVlans: number[];
  lagId?: number;
  poe?: PoePort;
}

export interface Vlan {
  vid: number;
  name?: string;
  members: {
    tagged: number[]; // port numbers (bridge ports)
    untagged: number[];
  };
  active: boolean;
  source: "static" | "current" | "private";
}

export interface Lag {
  id: number;
  members: number[];
  mode: "static" | "lacp" | "unknown";
}

/** A full read of a device at a point in time. */
export interface DeviceState {
  device: Device;
  ports: Port[];
  vlans: Vlan[];
  lags: Lag[];
  readAt: string; // ISO
}

// ---- Edits / transactions (write path; see §6 of the design doc) ----

export type Edit =
  | { kind: "setPvid"; bridgePort: number; vid: number }
  | { kind: "setVlanMembership"; vid: number; tagged: number[]; untagged: number[] }
  | { kind: "setPortAdmin"; ifIndex: number; up: boolean }
  | { kind: "setPortLabel"; ifIndex: number; label: string }
  | { kind: "setPoe"; bridgePort: number; on: boolean }
  | { kind: "setLag"; bridgePort: number; lagId: number | null }
  | { kind: "createVlan"; vid: number; name?: string }
  | { kind: "deleteVlan"; vid: number };

export interface DiffEntry {
  edit: Edit;
  before: unknown;
  after: unknown;
  /** Set if this edit risks stranding the management path, etc. */
  warning?: string;
}

export type ChangeSetStatus =
  | "planned"
  | "applying"
  | "applied"
  | "verified"
  | "rolledback"
  | "failed";

export interface OpResult {
  edit: Edit;
  ok: boolean;
  verified: boolean;
  error?: string;
}

export interface ChangeSet {
  id: string;
  deviceId: string;
  edits: Edit[];
  diff: DiffEntry[];
  results: OpResult[];
  status: ChangeSetStatus;
  snapshotId?: string;
}

export interface Snapshot {
  id: string;
  deviceId: string;
  takenAt: string;
  state: DeviceState;
}

export interface DiscoveryResult {
  host: string;
  transport: TransportKind;
  model?: string;
  baseMac?: string;
  vendorEnterprise?: number;
}

// ---- Topology helpers (read-only): LLDP neighbours + forwarding database ----

export interface LldpNeighbor {
  /** lldpRemLocalPortNum (correlate to a local port). */
  localPort: number;
  remoteSysName?: string;
  remotePortId?: string;
  remotePortDesc?: string;
  remoteChassisId?: string;
}

export interface FdbEntry {
  mac: string; // "aa:bb:cc:dd:ee:ff"
  bridgePort: number;
  vlan?: number; // Q-BRIDGE fdbId/VLAN (absent on the BRIDGE-MIB fallback)
}

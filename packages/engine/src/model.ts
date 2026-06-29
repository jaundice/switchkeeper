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
  | { kind: "deleteVlan"; vid: number }
  // Phase 3 generic write: SET an arbitrary writable vendor object. `oid` is the
  // FULLY-QUALIFIED instance OID (e.g. a scalar's ".0"); `name` is optional (the symbol,
  // for display/audit); `snmpType` is the net-snmp ObjectType code — if omitted, the apply
  // path infers it from the resolved MibSyntax. This kind is NEVER classified "safe".
  | { kind: "setObject"; oid: string; value: string | number; snmpType?: number; name?: string };

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
  /** Phase 2 SafetyEngine report (populated by the plan path). */
  safety?: SafetyReport;
}

// ---- Phase 2 SafetyEngine: protected-path detection + edit classification ----
// (Shapes pinned by docs/specs/phase2-contract.md. The engine derives these at plan time and
//  the apply path gates on them; the surfaces/UI layer renders them.)

/** Severity of an edit's effect on the management path. */
export type SafetyClass = "safe" | "risky" | "blocked";

/** Ports/VLANs the app must not strand. Derived per device at plan time. */
export interface ProtectedSet {
  ports: number[]; // bridge ports carrying (or likely carrying) management
  vlans: number[]; // management VLAN id(s)
  reason: string; // how it was derived (for display + audit)
  confidence: "high" | "medium" | "low";
}

/** One classified edit: its severity and a human explanation. */
export interface EditClassification {
  edit: Edit;
  cls: SafetyClass;
  reason: string; // e.g. "disables the uplink (port 49)"
}

/** The full safety assessment for a planned change set. */
export interface SafetyReport {
  protectedSet: ProtectedSet;
  classifications: EditClassification[];
  worst: SafetyClass; // max severity across all edits ("safe" if none)
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

// ---- MIB-driven model (Phase 1): resolver + adaptive capability model ----
// Shapes pinned by docs/specs/phase1-contract.md. Both the engine and the surfaces/UI
// layer depend on these exact shapes, so they live here (re-exported from index.ts).

/** SNMP MAX-ACCESS, normalised. "unknown" when the MIB didn't state one. */
export type ObjectAccess = "read-only" | "read-write" | "not-accessible" | "unknown";

// ---- Phase 3: MIB SYNTAX description (drives type-aware editors + generic SET varbinds) ----
// Shapes pinned by docs/specs/phase3-contract.md. The engine parses these from MIB text
// (net-snmp's store exposes only base type + maxAccess, not enums/ranges/TC/DESCRIPTION).

/** Normalised SYNTAX category that picks the editor widget. */
export type MibBaseType =
  | "integer" | "unsigned" | "enum" | "boolean" | "string" | "oid"
  | "ipaddress" | "counter" | "timeticks" | "bits" | "unknown";

export interface MibEnumValue { label: string; value: number }

/** Editor-oriented description of one object's SYNTAX, parsed from the MIB text. */
export interface MibSyntax {
  base: MibBaseType;                        // normalized category that picks the editor widget
  snmpType?: number;                        // net-snmp ObjectType code, for building the SET varbind
  enums?: MibEnumValue[];                   // for base "enum"/"boolean"
  range?: { min: number; max: number };     // INTEGER value range, if constrained
  sizeRange?: { min: number; max: number }; // OCTET STRING length range, if constrained
  tc?: string;                              // textual-convention name, if the SYNTAX referenced one
  units?: string;                          // UNITS clause, if present
  description?: string;                    // DESCRIPTION text (trimmed)
  access?: ObjectAccess;                   // MAX-ACCESS (read-write/read-create are editable)
}

/**
 * A symbol resolved to an OID + metadata, carrying its provenance so the UI knows
 * whether the object came from the device's own vendor MIBs, the standard baseline,
 * or a hand-coded vendor profile.
 */
export interface ResolvedObject {
  name: string; // symbol, e.g. "extremePortName" or "ifName"
  oid: string; // numeric OID (no trailing instance)
  module: string; // defining MIB module, or "standard" / a profile name
  source: "device-mib" | "standard" | "profile";
  type?: string; // human SYNTAX label if known (e.g. "Integer32", "DisplayString")
  access?: ObjectAccess; // from MIB MAX-ACCESS where known
}

/** One displayed scalar value. */
export interface CapabilityValue {
  name: string; // label (symbol or friendly name)
  oid: string; // fully-qualified OID that was read (scalar instance, e.g. ".0")
  value: string | number | null;
  type?: string;
}

// ---- Phase 4: columnar / table objects (read + guarded cell edit) ----
// Shapes pinned by docs/specs/phase4-contract.md. Back-compatible: existing curated tables keep
// working with just columns/rows; generic editable tables additionally carry columnMeta/rowKeys/
// index so the UI can build per-cell editors and the SafetyEngine can map a cell's row back to a
// port/VLAN. A cell (column c, row r) is editable iff columnMeta[c].access === "read-write"; its
// instance OID is columnMeta[c].oid + "." + rowKeys[r].

/** Per-column metadata aligned to CapabilityTable.columns[] (generic editable tables only). */
export interface CapabilityColumnMeta {
  name: string;         // column symbol, e.g. "extremePortLoadShareGroupId"
  oid: string;          // the COLUMN base OID (no instance)
  access: ObjectAccess; // read-write columns are editable
  base: MibBaseType;    // editor widget category (full enums/range fetched via object-meta)
}

/** A displayed table (rows of cells), columns describing each cell. */
export interface CapabilityTable {
  columns: string[];                    // header labels (existing)
  rows: (string | number | null)[][];   // existing
  columnMeta?: CapabilityColumnMeta[];  // aligned to columns[]; present on generic editable tables
  rowKeys?: string[];                   // instance suffix per row, aligned to rows[] (e.g. "49" or "1.20")
  index?: string;                       // human note on the index, e.g. "ifIndex" / "dot1qVlan" / "raw"
  // Lazy-tables (Phase 4 perf): true on a STUB section — columns/columnMeta/index are present but the
  // rows are NOT walked (rows=[], rowKeys=[]). The capability read only LISTS vendor tables (cheap, no
  // SNMP); the client fetches a table's rows on demand via readTable()/POST /api/table. Absent/false on
  // a fully-loaded section (curated tables, or a table returned by readTable).
  lazy?: boolean;
}

/**
 * One UI section. Only emitted when it actually has content for this device.
 * "curated" sections are the hand-bound categories (System, Ports, ...); "generic"
 * sections are auto-built per vendor MIB module and gated behind Advanced mode.
 */
export interface CapabilitySection {
  id: string; // "system" | "ports" | "vlans" | "poe" | "sensors" | "lldp" | "lag" | "stacking" | <module>
  title: string; // human title
  kind: "curated" | "generic";
  scalars?: CapabilityValue[];
  table?: CapabilityTable;
}

/** The whole adaptive model the UI renders. Sections in display order: curated first, then generic. */
export interface CapabilityModel {
  host: string;
  vendor: string; // profile name or "Unknown"
  mibs: { loaded: number; indexed: number }; // 0/0 if no MIBs loaded
  sections: CapabilitySection[];
}

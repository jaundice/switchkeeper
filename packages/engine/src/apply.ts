// M1 write path: turn high-level Edits into SNMP sets, plan a diff against current state,
// and apply with read-back verification + rollback. The safety model (design section 6) lives here.
import type { SnmpClient } from "./snmp.ts";
import { asInt, asBuffer, asString } from "./util.ts";
import { OID } from "./oids.ts";
import { encodePortList, decodePortList } from "./portlist.ts";
import { describeObject } from "./mibSyntax.ts";
import type { MibStore } from "./mib.ts";
import type {
  ChangeSet,
  DeviceState,
  DiffEntry,
  Edit,
  OpResult,
  Port,
  Vlan,
} from "./model.ts";

// net-snmp ASN.1 type codes (numeric, to avoid depending on ObjectType key names).
const T = { Integer: 2, OctetString: 4, OID: 6, IpAddress: 64, Counter: 65, Gauge32: 66, TimeTicks: 67 } as const;

// Types we build numeric (integer-family) varbinds for; everything else is an OCTET STRING / dotted
// string. Used to coerce a generic setObject value to the right wire shape.
const NUMERIC_TYPES = new Set<number>([T.Integer, T.Gauge32, T.Counter, T.TimeTicks]);

export interface VarbindSet {
  oid: string;
  type: number;
  value: number | Buffer;
}

export interface ApplyOptions {
  /** If set, every applied edit is reverted after this many ms unless confirm() is called. */
  autoRevertMs?: number;
  /** Ports the management path runs through; edits touching them are refused unless force. */
  managementPorts?: number[];
  force?: boolean;
  /** MIB store, so a generic setObject without an explicit snmpType can infer it from the SYNTAX. */
  mib?: MibStore;
}

// ---------------------------------------------------------------------------
// Encoding: Edit -> SNMP varbinds (pure)
// ---------------------------------------------------------------------------

export function editToVarbinds(edit: Edit, state: DeviceState, mib?: MibStore): VarbindSet[] {
  const width = state.device.capabilities?.portListWidth ?? 32;
  switch (edit.kind) {
    case "setPvid":
      return [{ oid: `${OID.dot1qPvid}.${edit.bridgePort}`, type: T.Gauge32, value: edit.vid }];

    case "setVlanMembership": {
      const egress = uniq([...edit.tagged, ...edit.untagged]);
      return [
        {
          oid: `${OID.dot1qVlanStaticEgressPorts}.${edit.vid}`,
          type: T.OctetString,
          value: Buffer.from(encodePortList(egress, width)),
        },
        {
          oid: `${OID.dot1qVlanStaticUntaggedPorts}.${edit.vid}`,
          type: T.OctetString,
          value: Buffer.from(encodePortList(edit.untagged, width)),
        },
      ];
    }

    case "setPortAdmin":
      return [{ oid: `${OID.ifAdminStatus}.${edit.ifIndex}`, type: T.Integer, value: edit.up ? 1 : 2 }];

    case "setPoe":
      // pethPsePortAdminEnable is TruthValue (1=true, 2=false), indexed group.port (group 1).
      return [{ oid: `${OID.pethPsePortAdminEnable}.1.${edit.bridgePort}`, type: T.Integer, value: edit.on ? 1 : 2 }];

    case "setLag":
      // No confirmed write OID for LAG membership yet (guarded in planChanges/applyChangeSet).
      throw new Error("LAG editing over SNMP is not implemented for this model");

    case "setPortLabel":
      return [{ oid: `${OID.ifAlias}.${edit.ifIndex}`, type: T.OctetString, value: Buffer.from(edit.label, "utf8") }];

    case "createVlan": {
      const vbs: VarbindSet[] = [
        { oid: `${OID.dot1qVlanStaticRowStatus}.${edit.vid}`, type: T.Integer, value: 4 /* createAndGo */ },
      ];
      if (edit.name) vbs.push({ oid: `${OID.dot1qVlanStaticName}.${edit.vid}`, type: T.OctetString, value: Buffer.from(edit.name, "utf8") });
      return vbs;
    }

    case "deleteVlan":
      return [{ oid: `${OID.dot1qVlanStaticRowStatus}.${edit.vid}`, type: T.Integer, value: 6 /* destroy */ }];

    case "setObject":
      // Generic write: type comes from the edit, or is inferred from the resolved MIB SYNTAX.
      return [setObjectVarbind(edit, mib)];
  }
}

// Build a correctly-typed varbind for a generic setObject. snmpType resolution order: the edit's
// explicit snmpType -> describeObject(mib).snmpType -> error (we will NOT guess a type for an
// arbitrary writable object, because an SNMP agent rejects a type-mismatched SET and we'd rather
// fail loudly here than send a malformed write). The value is then coerced to that wire type, and
// clearly-wrong values (non-numeric for an integer type) are rejected defensively.
function setObjectVarbind(
  edit: Extract<Edit, { kind: "setObject" }>,
  mib?: MibStore,
): VarbindSet {
  let type = edit.snmpType;
  if (type === undefined && mib) {
    const syn = describeObject(mib, edit.name ?? edit.oid);
    type = syn?.snmpType;
  }
  if (type === undefined) {
    throw new Error(
      `setObject ${edit.oid}: no snmpType given and the MIB SYNTAX could not be resolved — refusing to guess a wire type`,
    );
  }
  const value = coerceSetValue(type, edit.value, edit.oid);
  return { oid: edit.oid, type, value };
}

// Coerce a generic value to the wire shape its SNMP type needs: a number for integer-family types,
// a Buffer for OCTET STRING, a dotted-decimal string (as bytes) for OID/IpAddress. Rejects values
// that can't be that type — e.g. "abc" for an Integer — rather than sending nonsense to the agent.
function coerceSetValue(type: number, raw: string | number, oid: string): number | Buffer {
  if (NUMERIC_TYPES.has(type)) {
    const n = typeof raw === "number" ? raw : Number(String(raw).trim());
    if (!Number.isFinite(n)) {
      throw new Error(`setObject ${oid}: value ${JSON.stringify(raw)} is not a valid number for this integer-typed object`);
    }
    if (!Number.isInteger(n)) {
      throw new Error(`setObject ${oid}: value ${JSON.stringify(raw)} must be a whole number for this integer-typed object`);
    }
    return n;
  }
  if (type === T.IpAddress || type === T.OID) {
    // net-snmp accepts a dotted-decimal string for IpAddress and a dotted OID string for OID.
    const s = asString(raw).trim();
    if (type === T.IpAddress && !/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
      throw new Error(`setObject ${oid}: value ${JSON.stringify(raw)} is not a dotted IPv4 address`);
    }
    if (type === T.OID && !/^\d+(\.\d+)*$/.test(s)) {
      throw new Error(`setObject ${oid}: value ${JSON.stringify(raw)} is not a dotted OID`);
    }
    return Buffer.from(s, "utf8");
  }
  // Default: OCTET STRING / unknown -> raw bytes of the string form.
  return Buffer.from(asString(raw), "utf8");
}

// ---------------------------------------------------------------------------
// Planning: diff desired edits against current state, attach guard warnings
// ---------------------------------------------------------------------------

export function planChanges(
  state: DeviceState,
  edits: Edit[],
  opts: ApplyOptions = {},
): ChangeSet {
  const mgmt = new Set(opts.managementPorts ?? []);
  const diff: DiffEntry[] = edits.map((edit) => {
    const { before, after } = describe(edit, state);
    const warning = guard(edit, state, mgmt);
    return { edit, before, after, warning };
  });
  return {
    id: `cs-${Date.now()}`,
    deviceId: state.device.id,
    edits,
    diff,
    results: [],
    status: "planned",
  };
}

function describe(edit: Edit, state: DeviceState): { before: unknown; after: unknown } {
  switch (edit.kind) {
    case "setPvid": {
      const p = portByBridge(state, edit.bridgePort);
      return { before: { pvid: p?.pvid }, after: { pvid: edit.vid } };
    }
    case "setVlanMembership": {
      const v = state.vlans.find((x) => x.vid === edit.vid);
      return { before: v?.members ?? { tagged: [], untagged: [] }, after: { tagged: uniq(edit.tagged), untagged: uniq(edit.untagged) } };
    }
    case "setPortAdmin": {
      const p = state.ports.find((x) => x.ifIndex === edit.ifIndex);
      return { before: { admin: p?.adminStatus }, after: { admin: edit.up ? "up" : "down" } };
    }
    case "setPoe": {
      const p = portByBridge(state, edit.bridgePort);
      return { before: { poe: p?.poe?.adminOn }, after: { poe: edit.on } };
    }
    case "setLag": {
      const p = portByBridge(state, edit.bridgePort);
      return { before: { lagId: p?.lagId ?? null }, after: { lagId: edit.lagId } };
    }
    case "setPortLabel": {
      const p = state.ports.find((x) => x.ifIndex === edit.ifIndex);
      return { before: { label: p?.label }, after: { label: edit.label } };
    }
    case "createVlan":
      return { before: null, after: { vid: edit.vid, name: edit.name } };
    case "deleteVlan":
      return { before: { vid: edit.vid }, after: null };
    case "setObject":
      // The current (before) value needs a read-only GET against the device, which `describe` (pure)
      // can't do. planChanges fills it via readSetObjectBefore when a client is supplied; here we
      // record `after` and leave `before` undefined for the sync/no-client path.
      return { before: undefined, after: { oid: edit.oid, value: edit.value } };
  }
}

/**
 * Read-only diff enrichment for setObject edits: GET each setObject OID's current value and write it
 * into the matching diff entry's `before` (so a plan shows what the value is changing FROM). Pure
 * read — no SET. Best-effort: a GET error leaves `before` undefined rather than failing the plan.
 */
export async function readSetObjectBefore(
  client: SnmpClient,
  edits: Edit[],
  diff: DiffEntry[],
): Promise<void> {
  const targets = edits
    .map((e, i) => ({ e, i }))
    .filter((x): x is { e: Extract<Edit, { kind: "setObject" }>; i: number } => x.e.kind === "setObject");
  if (!targets.length) return;
  let vbs: { value: unknown }[] = [];
  try {
    vbs = await client.get(targets.map((t) => t.e.oid));
  } catch {
    return; // device read failed — leave before undefined
  }
  targets.forEach((t, k) => {
    const raw = vbs[k]?.value;
    const before = raw === undefined ? undefined : Buffer.isBuffer(raw) ? asString(raw) : raw;
    diff[t.i] = { ...diff[t.i], before: { oid: t.e.oid, value: before } };
  });
}

/** Lockout guard: refuse/flag edits that could strand the management path. */
function guard(edit: Edit, state: DeviceState, mgmt: Set<number>): string | undefined {
  if (edit.kind === "createVlan" && state.device.capabilities && !state.device.capabilities.canCreateVlan) {
    return `cannot create VLANs over SNMP on this model - create VLAN ${edit.vid} in the switch UI first, then assign ports`;
  }
  if (edit.kind === "setLag" && state.device.capabilities && !state.device.capabilities.canEditLag) {
    return `cannot edit LAG membership over SNMP on this model - confirm the OID out of production first`;
  }
  const touched = touchedBridgePort(edit);
  if (touched !== undefined && mgmt.has(touched)) {
    return `port ${touched} is a management path - changing it could lock you out`;
  }
  if ((edit.kind === "setPvid" || edit.kind === "setPoe")) {
    const p = portByBridge(state, touched!);
    if (p?.operStatus === "up") return `port ${touched} is currently UP (link active) - verify this is intended`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Apply: set -> read-back verify -> rollback on mismatch
// ---------------------------------------------------------------------------

export async function applyChangeSet(
  client: SnmpClient,
  state: DeviceState,
  cs: ChangeSet,
  opts: ApplyOptions = {},
): Promise<ChangeSet> {
  if (!opts.force) {
    const blocked = cs.diff.find((d) => d.warning && (d.warning.includes("lock you out") || d.warning.includes("cannot create") || d.warning.includes("cannot edit LAG")));
    if (blocked) {
      return { ...cs, status: "failed", results: [{ edit: blocked.edit, ok: false, verified: false, error: blocked.warning }] };
    }
  }

  const results: OpResult[] = [];
  const applied: { edit: Edit; rollback: VarbindSet[] }[] = [];

  for (const edit of cs.edits) {
    const target = editToVarbinds(edit, state, opts.mib);
    const rollback = await computeRollback(client, edit, state, target);
    try {
      await client.set(target);
    } catch (e) {
      // Genuine SNMP SET failure: the device rejected this edit, so nothing changed for it.
      // Revert prior accepted edits and stop.
      results.push({ edit, ok: false, verified: false, error: (e as Error).message });
      await rollbackAll(client, applied);
      return { ...cs, results, status: "failed" };
    }
    // The device ACCEPTED the SET (no SNMP error) -> the change is real. Record it as applied.
    // verifyEdit is informational only: a read-back miss (e.g. an empty VLAN absent from the
    // *current* table) must NOT trigger a rollback or abort the batch.
    applied.push({ edit, rollback });
    let verified = false;
    try { verified = await verifyEdit(client, edit, target); } catch { verified = false; }
    results.push({ edit, ok: true, verified });
  }

  // optional auto-revert timer (test/preview mode) reverts everything that was applied
  if (opts.autoRevertMs && opts.autoRevertMs > 0) {
    await delay(opts.autoRevertMs);
    await rollbackAll(client, applied);
    return { ...cs, results, status: "rolledback" };
  }

  // All SETs were accepted. "verified" if every read-back confirmed; otherwise "applied"
  // (changes are live but at least one couldn't be confirmed via read-back).
  return { ...cs, results, status: results.every((r) => r.verified) ? "verified" : "applied" };
}

/** Inverse of an edit, for rollback. create/delete need semantic inverses (a snapshot of a
 *  not-yet-existing row can't be replayed); everything else reverts to its prior value. */
async function computeRollback(client: SnmpClient, edit: Edit, state: DeviceState, target: VarbindSet[]): Promise<VarbindSet[]> {
  if (edit.kind === "createVlan") {
    return [{ oid: `${OID.dot1qVlanStaticRowStatus}.${edit.vid}`, type: T.Integer, value: 6 /* destroy */ }];
  }
  if (edit.kind === "deleteVlan") {
    const v = state.vlans.find((x) => x.vid === edit.vid);
    const vbs: VarbindSet[] = [{ oid: `${OID.dot1qVlanStaticRowStatus}.${edit.vid}`, type: T.Integer, value: 4 /* createAndGo */ }];
    if (v?.name) vbs.push({ oid: `${OID.dot1qVlanStaticName}.${edit.vid}`, type: T.OctetString, value: Buffer.from(v.name, "utf8") });
    return vbs; // best-effort: recreates the VLAN (member ports are not restored)
  }
  return snapshotVarbinds(client, target);
}

/** Read the current values of the OIDs we're about to set, so we can revert. */
async function snapshotVarbinds(client: SnmpClient, target: VarbindSet[]): Promise<VarbindSet[]> {
  const vbs = await client.get(target.map((t) => t.oid));
  return vbs.map((vb, i) => ({
    oid: target[i].oid,
    type: target[i].type,
    // Numeric (integer-family) types revert as a number; everything else (OCTET STRING, OID,
    // IpAddress) reverts as the raw bytes we read back.
    value: NUMERIC_TYPES.has(target[i].type) ? asInt(vb.value) : asBuffer(vb.value),
  }));
}

/** Read live VLAN membership from the Q-BRIDGE *current* table (authoritative on models
 *  like the GS748 where the static table doesn't reflect writes back). */
async function readCurrentMembership(client: SnmpClient, vid: number): Promise<{ egress: Set<number>; untagged: Set<number> }> {
  const eg = await client.column(OID.dot1qVlanCurrentEgressPorts);
  const ut = await client.column(OID.dot1qVlanCurrentUntaggedPorts);
  const pick = (col: Map<string, { value: unknown }>) => {
    for (const [idx, vb] of col) {
      const parts = idx.split(".");
      if (Number(parts[parts.length - 1]) === vid) return new Set(decodePortList(asBuffer(vb.value)));
    }
    return new Set<number>();
  };
  return { egress: pick(eg), untagged: pick(ut) };
}

async function verifyEdit(client: SnmpClient, edit: Edit, target: VarbindSet[]): Promise<boolean> {
  // VLAN create/delete: verify row existence in the *static* table. (The previous code compared
  // the RowStatus read-back to the value we wrote -- createAndGo(4) -- which never matches, since
  // a live row reports active(1); that caused every create/delete to "fail" verify.)
  if (edit.kind === "createVlan") {
    const rs = await vlanStaticRowStatus(client, edit.vid);
    return rs !== undefined && rs !== 6; // present (active/notInService/notReady), not destroyed
  }
  if (edit.kind === "deleteVlan") {
    const rs = await vlanStaticRowStatus(client, edit.vid);
    return rs === undefined || rs === 6; // row gone
  }
  if (edit.kind === "setVlanMembership") {
    const wantEgress = new Set(uniq([...edit.tagged, ...edit.untagged]));
    const wantUntagged = new Set(uniq(edit.untagged));
    const cur = await readCurrentMembership(client, edit.vid);
    if (setEq(wantEgress, cur.egress) && setEq(wantUntagged, cur.untagged)) return true;
    // Empty VLANs (no member ports) can be absent from the current table on some vendors
    // (e.g. EXOS) -> fall back to the static membership columns.
    const stat = await readStaticMembership(client, edit.vid);
    return setEq(wantEgress, stat.egress) && setEq(wantUntagged, stat.untagged);
  }
  // Generic setObject: read the OID back and compare to the value we set. OCTET STRING here is an
  // ARBITRARY string (not a PortList), so compare bytes directly — never via decodePortList.
  if (edit.kind === "setObject") {
    const got = await client.get(target.map((t) => t.oid));
    return target.every((t, i) => {
      const v = got[i].value;
      if (NUMERIC_TYPES.has(t.type)) return asInt(v) === (t.value as number);
      return asBuffer(v).equals(asBuffer(t.value));
    });
  }
  const got = await client.get(target.map((t) => t.oid));
  return target.every((t, i) => {
    const v = got[i].value;
    if (t.type === T.OctetString) {
      return setsEqual(decodePortList(asBuffer(v)), decodePortList(t.value as Buffer));
    }
    return asInt(v) === (t.value as number);
  });
}

/** RowStatus of a VLAN in the Q-BRIDGE *static* table, or undefined if no such row. */
async function vlanStaticRowStatus(client: SnmpClient, vid: number): Promise<number | undefined> {
  const col = await client.column(OID.dot1qVlanStaticRowStatus);
  for (const [idx, vb] of col) {
    const parts = idx.split(".");
    if (Number(parts[parts.length - 1]) === vid) return asInt(vb.value);
  }
  return undefined;
}

/** VLAN membership from the Q-BRIDGE *static* table (fallback verify source for empty VLANs). */
async function readStaticMembership(client: SnmpClient, vid: number): Promise<{ egress: Set<number>; untagged: Set<number> }> {
  const eg = await client.column(OID.dot1qVlanStaticEgressPorts);
  const ut = await client.column(OID.dot1qVlanStaticUntaggedPorts);
  const pick = (col: Map<string, { value: unknown }>) => {
    for (const [idx, vb] of col) {
      const parts = idx.split(".");
      if (Number(parts[parts.length - 1]) === vid) return new Set(decodePortList(asBuffer(vb.value)));
    }
    return new Set<number>();
  };
  return { egress: pick(eg), untagged: pick(ut) };
}

function setEq(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

async function rollbackAll(client: SnmpClient, applied: { rollback: VarbindSet[] }[]): Promise<void> {
  for (const a of applied.reverse()) {
    try {
      await client.set(a.rollback);
    } catch {
      /* best-effort revert */
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function uniq(xs: number[]): number[] {
  return [...new Set(xs)].sort((a, b) => a - b);
}
function portByBridge(state: DeviceState, bridgePort?: number): Port | undefined {
  return bridgePort === undefined ? undefined : state.ports.find((p) => p.bridgePort === bridgePort);
}
function touchedBridgePort(edit: Edit): number | undefined {
  if (edit.kind === "setPvid" || edit.kind === "setPoe") return edit.bridgePort;
  return undefined;
}
function setsEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type { Vlan };

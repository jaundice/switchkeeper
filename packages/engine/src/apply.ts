// M1 write path: turn high-level Edits into SNMP sets, plan a diff against current state,
// and apply with read-back verification + rollback. The safety model (design section 6) lives here.
import type { SnmpClient } from "./snmp.ts";
import { asInt, asBuffer } from "./util.ts";
import { OID } from "./oids.ts";
import { encodePortList, decodePortList } from "./portlist.ts";
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
const T = { Integer: 2, OctetString: 4, Gauge32: 66 } as const;

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
}

// ---------------------------------------------------------------------------
// Encoding: Edit -> SNMP varbinds (pure)
// ---------------------------------------------------------------------------

export function editToVarbinds(edit: Edit, state: DeviceState): VarbindSet[] {
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
  }
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
  }
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
    const target = editToVarbinds(edit, state);
    const rollback = await snapshotVarbinds(client, target);
    try {
      await client.set(target);
      const ok = await verifyEdit(client, edit, target);
      results.push({ edit, ok, verified: ok });
      if (ok) {
        applied.push({ edit, rollback });
      } else {
        // verify failed -> roll back everything applied so far (including this attempt)
        await rollbackAll(client, [...applied, { edit, rollback }]);
        return { ...cs, results, status: "rolledback" };
      }
    } catch (e) {
      results.push({ edit, ok: false, verified: false, error: (e as Error).message });
      await rollbackAll(client, applied);
      return { ...cs, results, status: "failed" };
    }
  }

  // optional auto-revert timer (test/preview mode)
  if (opts.autoRevertMs && opts.autoRevertMs > 0) {
    await delay(opts.autoRevertMs);
    await rollbackAll(client, applied);
    return { ...cs, results, status: "rolledback" };
  }

  return { ...cs, results, status: "verified" };
}

/** Read the current values of the OIDs we're about to set, so we can revert. */
async function snapshotVarbinds(client: SnmpClient, target: VarbindSet[]): Promise<VarbindSet[]> {
  const vbs = await client.get(target.map((t) => t.oid));
  return vbs.map((vb, i) => ({
    oid: target[i].oid,
    type: target[i].type,
    value: target[i].type === T.OctetString ? asBuffer(vb.value) : asInt(vb.value),
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
  if (edit.kind === "setVlanMembership") {
    // Verify against the current table, not the static OIDs we wrote.
    const got = await readCurrentMembership(client, edit.vid);
    return setEq(new Set(uniq([...edit.tagged, ...edit.untagged])), got.egress)
      && setEq(new Set(uniq(edit.untagged)), got.untagged);
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

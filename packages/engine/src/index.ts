// @switchkeeper/engine — public surface.
// (Phase 2 adds SafetyEngine exports + safety wiring in planDevice/applyDevice below.)
export * from "./model.ts";
export { OID, RowStatus, enterpriseFromSysObjectID } from "./oids.ts";
export {
  decodePortList,
  encodePortList,
  withPort,
  isPortSet,
  hexToBytes,
  bytesToHex,
} from "./portlist.ts";
export { profileForEnterprise, registerProfile, type VendorProfile } from "./profiles.ts";
export { SnmpClient, type VarBind, type SnmpOptions } from "./snmp.ts";
export { probe } from "./capabilities.ts";
export { readState } from "./readState.ts";
export {
  editToVarbinds,
  planChanges,
  applyChangeSet,
  type ApplyOptions,
  type VarbindSet,
} from "./apply.ts";
export { saveRunningConfig, type SaveResult } from "./save.ts";
export { discover, discoverMany, type DiscoverOptions } from "./discover.ts";
export { expandTargets, ipToInt, intToIp } from "./targets.ts";
export { listInterfaces, netmaskToPrefix, networkOf, type LocalInterface } from "./interfaces.ts";
export { createMibStore, type MibStore, type MibObject } from "./mib.ts";
export { mibPointersFor, mibSearchUrl, hasCuratedMibSource, type MibSource, type MibLink } from "./mibSources.ts";
export { readFdb, readLldpNeighbors, macFromIndexTail, lldpLocalPortFromIndex } from "./topology.ts";
export {
  detectProtectedSet,
  classifyEdits,
  gateDecision,
  worstOf,
  type DetectOptions,
  type Acknowledge,
} from "./safety.ts";
// Note: SafetyClass, ProtectedSet, EditClassification, SafetyReport are exported via
// `export * from "./model.ts"` above.
export { saveConfigVarbinds } from "./save.ts";
export { type SaveMethod } from "./profiles.ts";
// MIB-driven model (Phase 1): resolver + adaptive capability model. Types come via model.ts.
export {
  createObjectResolver,
  resolvedFromMibObject,
  accessFromMaxAccess,
  typeFromScalarType,
  type ObjectResolver,
} from "./objectResolver.ts";
export {
  readDeviceCapabilities,
  buildCuratedSections,
  buildGenericSections,
  selectGenericCandidates,
  scalarInstanceOid,
  type Topology,
} from "./deviceCapabilities.ts";

import { SnmpClient } from "./snmp.ts";
import { probe } from "./capabilities.ts";
import { readState } from "./readState.ts";
import { planChanges, applyChangeSet } from "./apply.ts";
import { saveRunningConfig } from "./save.ts";
import { readFdb, readLldpNeighbors } from "./topology.ts";
import { localSourceMac } from "./interfaces.ts";
import { detectProtectedSet, classifyEdits, gateDecision, type Acknowledge } from "./safety.ts";
import { OID } from "./oids.ts";
import { asString } from "./util.ts";
import type { ChangeSet, Credential, DeviceState, Edit, FdbEntry, LldpNeighbor } from "./model.ts";
import type { SaveResult } from "./save.ts";

/** Convenience: connect read-only and return a full DeviceState. */
export async function readDevice(host: string, credential: Credential): Promise<DeviceState> {
  const client = new SnmpClient(host, credential);
  try {
    const { device, capabilities } = await probe(client, host);
    return await readState(client, device, capabilities);
  } finally {
    client.close();
  }
}

/**
 * Connect, read, and plan a set of edits (no writes). Phase 2: also reads topology (FDB + LLDP,
 * read-only), derives the protected management path, classifies every edit, and attaches the
 * SafetyReport to ChangeSet.safety.
 */
export async function planDevice(
  host: string,
  credential: Credential,
  edits: Edit[],
  opts: { sourceMac?: string; mgmtVlan?: number } = {},
): Promise<ChangeSet> {
  const client = new SnmpClient(host, credential);
  try {
    const { device, capabilities } = await probe(client, host);
    const state = await readState(client, device, capabilities);
    const cs = planChanges(state, edits);
    // Topology reads are best-effort: a switch with no LLDP/FDB must still plan. On error we fall
    // back to empty topology, which forces detectProtectedSet down its conservative path.
    const topo = await readTopologySafe(client);
    // Auto-pin the mgmt port via our own source MAC when L2-adjacent (high confidence); the caller
    // can still override with an explicit opts.sourceMac.
    const detOpts = { ...opts, sourceMac: opts.sourceMac ?? localSourceMac(host) };
    const protectedSet = detectProtectedSet(state, topo, detOpts);
    cs.safety = classifyEdits(edits, state, protectedSet);
    return cs;
  } finally {
    client.close();
  }
}

/**
 * Connect, read, plan, apply (verify + rollback), and optionally save.
 *
 * Phase 2 SafetyEngine gating (contract section: commit-confirm/no-auto-save):
 *  - BEFORE sending any SET, classify the edits against the derived protected set. If any edit is
 *    `blocked` and !acknowledge.allowBlocked -> refuse (return a failed ChangeSet, no SETs sent).
 *    Same for `risky` and !acknowledge.allowRisky.
 *  - After applying running config, re-check reachability (re-read sysName) and surface
 *    `reachableAfter` on the result.
 *  - Save (running -> startup) ONLY happens when opts.save AND reachableAfter; never automatically.
 *  - The existing per-edit read-back verify + rollback-on-SET-error behaviour is left intact.
 */
export async function applyDevice(
  host: string,
  credential: Credential,
  edits: Edit[],
  opts: { save?: boolean; acknowledge?: Acknowledge; sourceMac?: string; mgmtVlan?: number } = {},
): Promise<{ changeSet: ChangeSet; save?: SaveResult; reachableAfter?: boolean }> {
  const client = new SnmpClient(host, credential);
  try {
    const { device, capabilities } = await probe(client, host);
    const state = await readState(client, device, capabilities);

    // 1. Classify + gate BEFORE any write.
    const topo = await readTopologySafe(client);
    const detOpts = { ...opts, sourceMac: opts.sourceMac ?? localSourceMac(host) };
    const protectedSet = detectProtectedSet(state, topo, detOpts);
    const safety = classifyEdits(edits, state, protectedSet);
    const cs = planChanges(state, edits);
    cs.safety = safety;

    const gate = gateDecision(safety, opts.acknowledge ?? {});
    if (gate.refuse) {
      // No SETs sent. Return a failed ChangeSet carrying the safety report and a clear error.
      // Surface the refusal reason against the first offending edit so callers see *why*.
      const offending =
        safety.classifications.find((c) => c.cls === "blocked") ??
        safety.classifications.find((c) => c.cls === "risky") ??
        safety.classifications[0];
      const results = offending
        ? [{ edit: offending.edit, ok: false, verified: false, error: gate.reason }]
        : [];
      return {
        changeSet: { ...cs, status: "failed", results, safety },
        reachableAfter: undefined,
      };
    }

    // 2. Apply (existing verify/rollback path, unchanged).
    const applied = await applyChangeSet(client, state, cs);
    applied.safety = safety;

    // 3. Post-apply reachability re-check (trivial OID: sysName). Conservative: any failure or
    //    empty read counts as NOT reachable, so we never auto-save on an uncertain link.
    const reachableAfter = await recheckReachable(client);

    // 4. Save ONLY when explicitly requested AND reachable. Never auto-save.
    const save = opts.save && reachableAfter ? await saveRunningConfig(client, device) : undefined;

    return { changeSet: applied, save, reachableAfter };
  } finally {
    client.close();
  }
}

/** Read topology read-only; swallow errors into empty arrays so planning never fails on topology. */
async function readTopologySafe(
  client: SnmpClient,
): Promise<{ fdb: FdbEntry[]; lldp: LldpNeighbor[] }> {
  let lldp: LldpNeighbor[] = [];
  let fdb: FdbEntry[] = [];
  try { lldp = await readLldpNeighbors(client); } catch { lldp = []; }
  try { fdb = await readFdb(client); } catch { fdb = []; }
  return { fdb, lldp };
}

/** Re-read sysName (a trivial scalar) to confirm the management link survived the apply.
 *  A successful GET (no transport error, a varbind back) = reachable. False on any error — we never
 *  auto-save on an uncertain link. */
async function recheckReachable(client: SnmpClient): Promise<boolean> {
  try {
    const vbs = await client.get([OID.sysName]); // OID.sysName already carries the .0 instance
    return vbs.length > 0 && asString(vbs[0].value) !== "";
  } catch {
    return false;
  }
}

/** Connect and persist running config (vendor-specific; may be unsupported). */
export async function saveDevice(host: string, credential: Credential): Promise<SaveResult> {
  const client = new SnmpClient(host, credential);
  try {
    const { device } = await probe(client, host);
    return await saveRunningConfig(client, device);
  } finally {
    client.close();
  }
}

/** Connect and read topology: LLDP neighbours + forwarding database (MAC -> port). */
export async function readTopology(
  host: string,
  credential: Credential,
): Promise<{ lldp: LldpNeighbor[]; fdb: FdbEntry[] }> {
  const client = new SnmpClient(host, credential);
  try {
    const lldp = await readLldpNeighbors(client);
    const fdb = await readFdb(client);
    return { lldp, fdb };
  } finally {
    client.close();
  }
}

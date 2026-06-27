// @switchkeeper/engine — public surface.
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
export { saveConfigVarbinds } from "./save.ts";
export { type SaveMethod } from "./profiles.ts";

import { SnmpClient } from "./snmp.ts";
import { probe } from "./capabilities.ts";
import { readState } from "./readState.ts";
import { planChanges, applyChangeSet } from "./apply.ts";
import { saveRunningConfig } from "./save.ts";
import { readFdb, readLldpNeighbors } from "./topology.ts";
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

/** Connect, read, and plan a set of edits (no writes). */
export async function planDevice(host: string, credential: Credential, edits: Edit[]): Promise<ChangeSet> {
  const client = new SnmpClient(host, credential);
  try {
    const { device, capabilities } = await probe(client, host);
    const state = await readState(client, device, capabilities);
    return planChanges(state, edits);
  } finally {
    client.close();
  }
}

/** Connect, read, plan, apply (verify + rollback), and optionally save. */
export async function applyDevice(
  host: string,
  credential: Credential,
  edits: Edit[],
  opts: { save?: boolean } = {},
): Promise<{ changeSet: ChangeSet; save?: SaveResult }> {
  const client = new SnmpClient(host, credential);
  try {
    const { device, capabilities } = await probe(client, host);
    const state = await readState(client, device, capabilities);
    const changeSet = await applyChangeSet(client, state, planChanges(state, edits));
    const save = opts.save ? await saveRunningConfig(client, device) : undefined;
    return { changeSet, save };
  } finally {
    client.close();
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

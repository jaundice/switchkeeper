// Persist the running config to startup. This is always vendor-specific (no standard SNMP
// object exists), so it is driven entirely by the VendorProfile. Where no save method is known
// for a model, we return a clear, honest message rather than guessing a write.
import type { SnmpClient } from "./snmp.ts";
import type { Device } from "./model.ts";
import { profileForEnterprise, type VendorProfile } from "./profiles.ts";

export interface SaveResult {
  ok: boolean;
  supported: boolean;
  message: string;
}

const INT = 2; // ASN.1 Integer

/** RADLAN-COPY-MIB rlCopyEntry column numbers (relative to the entry base OID). */
const RL = { sourceLocation: 3, sourceFileType: 7, destLocation: 8, destFileType: 12, rowStatus: 17 } as const;
const RL_LOC_LOCAL = 1;
const RL_FILE_RUNNING = 2;
const RL_FILE_STARTUP = 3;
const RL_ROW_CREATE_AND_GO = 4;

/** The SNMP set(s) that commit running->startup for a profile, or null if unknown. Pure/testable. */
export function saveConfigVarbinds(profile: VendorProfile): { oid: string; type: number; value: number }[] | null {
  const m = profile.save;
  if (m) {
    if (m.kind === "trigger") return [{ oid: m.oid, type: INT, value: m.value ?? 1 }];
    if (m.kind === "copyRunningToStartup") {
      const i = 1; // rlCopyIndex
      return [
        { oid: `${m.baseOid}.${RL.sourceLocation}.${i}`, type: INT, value: RL_LOC_LOCAL },
        { oid: `${m.baseOid}.${RL.sourceFileType}.${i}`, type: INT, value: RL_FILE_RUNNING },
        { oid: `${m.baseOid}.${RL.destLocation}.${i}`, type: INT, value: RL_LOC_LOCAL },
        { oid: `${m.baseOid}.${RL.destFileType}.${i}`, type: INT, value: RL_FILE_STARTUP },
        { oid: `${m.baseOid}.${RL.rowStatus}.${i}`, type: INT, value: RL_ROW_CREATE_AND_GO },
      ];
    }
  }
  // Back-compat: a bare integer-trigger OID on the profile.
  if (profile.saveConfigOid) return [{ oid: profile.saveConfigOid, type: INT, value: profile.saveConfigValue ?? 1 }];
  return null;
}

export async function saveRunningConfig(client: SnmpClient, device: Device): Promise<SaveResult> {
  const profile = profileForEnterprise(device.vendorEnterprise);
  const vbs = saveConfigVarbinds(profile);
  if (!vbs) {
    return {
      ok: false,
      supported: false,
      message:
        profile.saveConfigNote ??
        "No SNMP save-config object is known for this model. Changes may persist automatically; " +
          "to be certain they survive a reboot, use the switch UI's Save Configuration.",
    };
  }
  try {
    await client.set(vbs);
    return { ok: true, supported: true, message: "save-config triggered and accepted" };
  } catch (e) {
    return {
      ok: false,
      supported: true,
      message: "save-config failed: " + (e as Error).message + (profile.saveConfigNote ? " - " + profile.saveConfigNote : ""),
    };
  }
}

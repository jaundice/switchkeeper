// Persist the running config to startup. This is always vendor-specific (no standard SNMP
// object exists), so it is driven entirely by the VendorProfile. Where no save OID is known
// for a model, we return a clear, honest message rather than guessing a write.
import type { SnmpClient } from "./snmp.ts";
import type { Device } from "./model.ts";
import { profileForEnterprise } from "./profiles.ts";

export interface SaveResult {
  ok: boolean;
  supported: boolean;
  message: string;
}

export async function saveRunningConfig(client: SnmpClient, device: Device): Promise<SaveResult> {
  const profile = profileForEnterprise(device.vendorEnterprise);
  if (!profile.saveConfigOid) {
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
    // Save OIDs are integer triggers (set to a value to commit).
    await client.set([{ oid: profile.saveConfigOid, type: 2, value: profile.saveConfigValue ?? 1 }]);
    return { ok: true, supported: true, message: "save-config triggered and accepted" };
  } catch (e) {
    return { ok: false, supported: true, message: "save-config failed: " + (e as Error).message };
  }
}

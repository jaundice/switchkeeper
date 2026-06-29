import { test } from "node:test";
import assert from "node:assert/strict";
import { profileForEnterprise, registerProfile, type VendorProfile, type CommitConfirm } from "../src/profiles.ts";

// Polish deliverable #4: the rollback-timer (commit-confirm) hook is a SAFE no-op extension point.
// The binding invariant from the contract: ship the hook + types but add NO vendor values, and never
// change the default no-auto-save behaviour. These tests pin that invariant.

test("no shipped vendor profile defines commitConfirm (no-op by default)", () => {
  // The two known enterprises plus the generic fallback must all leave commitConfirm undefined.
  for (const ent of [4526 /* Netgear */, 1916 /* Extreme */, undefined /* generic */, 12345 /* unknown */]) {
    const p = profileForEnterprise(ent);
    assert.equal(p.commitConfirm, undefined, `enterprise ${ent} must not define commitConfirm`);
  }
});

test("CommitConfirm shape is { armOid, confirmOid, timeoutSec } and round-trips through the registry", () => {
  // A test-only profile proves the optional hook is wired through the profile type. We register it
  // under a throwaway enterprise so no real device is affected.
  const cc: CommitConfirm = { armOid: "1.3.6.1.4.1.999.1.0", confirmOid: "1.3.6.1.4.1.999.2.0", timeoutSec: 120 };
  const testProfile: VendorProfile = {
    enterprise: 99990001,
    name: "Test (commit-confirm capable)",
    vlanWritePath: "standard",
    pvidWritable: true,
    canCreateVlan: true,
    canEditLag: false,
    commitConfirm: cc,
  };
  registerProfile(testProfile);
  const got = profileForEnterprise(99990001);
  assert.deepEqual(got.commitConfirm, cc);
  assert.equal(got.commitConfirm!.timeoutSec, 120);
});

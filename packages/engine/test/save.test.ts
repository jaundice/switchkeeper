import { test } from "node:test";
import assert from "node:assert/strict";
import { saveConfigVarbinds } from "../src/save.ts";
import { profileForEnterprise } from "../src/profiles.ts";

test("Netgear save uses the rlCopy table: running -> startup, createAndGo", () => {
  const vbs = saveConfigVarbinds(profileForEnterprise(4526));
  assert.ok(vbs, "Netgear should now have a save method");
  assert.equal(vbs!.length, 5);
  const base = "1.3.6.1.4.1.89.87.2.1";
  assert.deepEqual(vbs!.map((v) => v.oid), [
    `${base}.3.1`, `${base}.7.1`, `${base}.8.1`, `${base}.12.1`, `${base}.17.1`,
  ]);
  // local(1), runningConfig(2), local(1), startupConfig(3), createAndGo(4)
  assert.deepEqual(vbs!.map((v) => v.value), [1, 2, 1, 3, 4]);
  assert.ok(vbs!.every((v) => v.type === 2)); // Integer
});

test("Extreme (1916) profile allows VLAN create over SNMP", () => {
  const p = profileForEnterprise(1916);
  assert.match(p.name, /Extreme|EXOS/);
  assert.equal(p.canCreateVlan, true);
  assert.equal(p.canEditLag, false);
});

test("an unknown vendor has no save method (honest, no guessed write)", () => {
  assert.equal(saveConfigVarbinds(profileForEnterprise(987654)), null);
});

test("a trigger-style save method emits a single integer set", () => {
  const vbs = saveConfigVarbinds({
    enterprise: 1, name: "t", vlanWritePath: "standard", pvidWritable: true,
    canCreateVlan: true, canEditLag: false, save: { kind: "trigger", oid: "1.2.3.0", value: 7 },
  });
  assert.deepEqual(vbs, [{ oid: "1.2.3.0", type: 2, value: 7 }]);
});

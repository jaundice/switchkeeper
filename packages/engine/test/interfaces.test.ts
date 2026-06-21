import { test } from "node:test";
import assert from "node:assert/strict";
import { netmaskToPrefix, networkOf, listInterfaces } from "../src/interfaces.ts";

test("netmaskToPrefix", () => {
  assert.equal(netmaskToPrefix("255.255.255.0"), 24);
  assert.equal(netmaskToPrefix("255.255.0.0"), 16);
  assert.equal(netmaskToPrefix("255.255.255.252"), 30);
  assert.equal(netmaskToPrefix("0.0.0.0"), 0);
});

test("networkOf masks the host bits", () => {
  assert.equal(networkOf("192.168.1.117", 24), "192.168.1.0");
  assert.equal(networkOf("10.1.2.3", 16), "10.1.0.0");
  assert.equal(networkOf("192.168.1.117", 30), "192.168.1.116");
});

test("listInterfaces returns well-formed entries", () => {
  const ifs = listInterfaces({ includeInternal: true });
  assert.ok(Array.isArray(ifs));
  for (const i of ifs) {
    assert.equal(typeof i.name, "string");
    assert.match(i.address, /^\d+\.\d+\.\d+\.\d+$/);
    assert.match(i.subnet, /^\d+\.\d+\.\d+\.\d+\/\d+$/);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { expandTargets, ipToInt, intToIp } from "../src/targets.ts";

test("ipToInt / intToIp round-trip", () => {
  assert.equal(intToIp(ipToInt("192.168.1.117")), "192.168.1.117");
  assert.equal(ipToInt("0.0.0.0"), 0);
  assert.equal(intToIp(0xc0a80175), "192.168.1.117");
});

test("/24 expands to 254 usable hosts (skips network + broadcast)", () => {
  const hosts = expandTargets("192.168.1.0/24");
  assert.equal(hosts.length, 254);
  assert.equal(hosts[0], "192.168.1.1");
  assert.equal(hosts.at(-1), "192.168.1.254");
});

test("/30 yields 2 usable hosts", () => {
  assert.deepEqual(expandTargets("10.0.0.0/30"), ["10.0.0.1", "10.0.0.2"]);
});

test("/32 yields the single host", () => {
  assert.deepEqual(expandTargets("192.168.1.117/32"), ["192.168.1.117"]);
});

test("last-octet range", () => {
  assert.deepEqual(expandTargets("192.168.1.10-12"), [
    "192.168.1.10", "192.168.1.11", "192.168.1.12",
  ]);
});

test("single IP passes through", () => {
  assert.deepEqual(expandTargets("192.168.1.117"), ["192.168.1.117"]);
});

test("CIDR is normalised to the network base", () => {
  // .117/24 should still enumerate the whole .0/24 usable range
  const hosts = expandTargets("192.168.1.117/24");
  assert.equal(hosts[0], "192.168.1.1");
  assert.equal(hosts.length, 254);
});

test("garbage spec throws", () => {
  assert.throws(() => expandTargets("not-an-ip"));
});

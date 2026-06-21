import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodePortList,
  encodePortList,
  withPort,
  isPortSet,
  hexToBytes,
  bytesToHex,
} from "../src/portlist.ts";

// ---------------------------------------------------------------------------
// Real bytes captured from a Netgear GS748TP, 2026-06-21:
//   dot1qVlanCurrentEgressPorts.0.1 (VLAN 1) =
//     FF FF FF FF FF FF 00 00 ... (118x 00) ... 01 FE   (126 bytes)
// Expected decode: physical ports 1-48 + LAG pseudo-ports 1000-1007.
// ---------------------------------------------------------------------------
const GS748_WIDTH = 126;
const vlan1Egress = hexToBytes(
  "FF ".repeat(6) + "00 ".repeat(118) + "01 FE",
);

test("fixture is the expected 126-byte width", () => {
  assert.equal(vlan1Egress.length, GS748_WIDTH);
});

test("decodes GS748 VLAN 1 to ports 1-48 + LAGs 1000-1007", () => {
  const ports = decodePortList(vlan1Egress);
  const expected = [
    ...Array.from({ length: 48 }, (_, i) => i + 1),
    1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007,
  ];
  assert.deepEqual(ports, expected);
});

test("the LAG tail byte 0xFE means 1001-1007, NOT 1008", () => {
  assert.equal(isPortSet(vlan1Egress, 1000), true);
  assert.equal(isPortSet(vlan1Egress, 1007), true);
  assert.equal(isPortSet(vlan1Egress, 1008), false);
});

test("empty bitmap decodes to no ports (a named-but-unassigned VLAN)", () => {
  const empty = new Uint8Array(GS748_WIDTH);
  assert.deepEqual(decodePortList(empty), []);
});

test("encode is the inverse of decode (round-trip)", () => {
  const ports = decodePortList(vlan1Egress);
  const reencoded = encodePortList(ports, GS748_WIDTH);
  assert.equal(bytesToHex(reencoded), bytesToHex(vlan1Egress));
});

test("write path: a single access port maps to the right bit", () => {
  // Putting port 23 (the AP port) untagged into a VLAN -> byte 2, bit 0x02.
  const buf = encodePortList([23], GS748_WIDTH);
  assert.equal(buf[2], 0x02);
  assert.deepEqual(decodePortList(buf), [23]);
});

test("withPort sets and clears without growing the buffer", () => {
  let buf = new Uint8Array(GS748_WIDTH);
  buf = withPort(buf, 1, true);
  assert.equal(buf[0], 0x80);
  buf = withPort(buf, 8, true);
  assert.equal(buf[0], 0x81);
  buf = withPort(buf, 1, false);
  assert.equal(buf[0], 0x01);
  assert.equal(buf.length, GS748_WIDTH);
});

test("encode rejects ports that overflow the declared width", () => {
  assert.throws(() => encodePortList([2000], GS748_WIDTH), /width/);
  assert.throws(() => encodePortList([0], 8), /invalid port/);
});

// IETF PortList codec (Q-BRIDGE-MIB / BRIDGE-MIB "PortList" textual convention).
//
// A PortList is an OCTET STRING where each bit represents a (bridge) port.
// Ports are 1-based. The bit for port p is in byte floor((p-1)/8), and within that
// byte the MOST significant bit (0x80) is the lowest-numbered port. So:
//
//   byteIndex(p) = (p - 1) >> 3
//   bitMask(p)   = 0x80 >> ((p - 1) & 7)
//
// Verified against a real Netgear GS748TP: VLAN 1 current-egress = FF FF FF FF FF FF ...
// 01 FE, which decodes to physical ports 1-48 plus LAG pseudo-ports 1000-1007.
//
// This module is pure (no I/O, no external deps) so it is trivially testable.

export function decodePortList(buf: Uint8Array): number[] {
  const ports: number[] = [];
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    if (byte === 0) continue;
    for (let b = 0; b < 8; b++) {
      if ((byte & (0x80 >> b)) !== 0) ports.push(i * 8 + b + 1);
    }
  }
  return ports;
}

export function encodePortList(ports: Iterable<number>, widthBytes: number): Uint8Array {
  const buf = new Uint8Array(widthBytes);
  for (const p of ports) {
    if (!Number.isInteger(p) || p < 1) {
      throw new RangeError(`invalid port number: ${p}`);
    }
    const idx = (p - 1) >> 3;
    if (idx >= widthBytes) {
      throw new RangeError(
        `port ${p} needs byte ${idx} but PortList width is only ${widthBytes} bytes`,
      );
    }
    buf[idx] |= 0x80 >> ((p - 1) & 7);
  }
  return buf;
}

/** Return a copy of `buf` with `port` set (does not grow the buffer). */
export function withPort(buf: Uint8Array, port: number, on: boolean): Uint8Array {
  const out = buf.slice();
  const idx = (port - 1) >> 3;
  if (idx >= out.length) {
    if (on) throw new RangeError(`port ${port} exceeds PortList width ${out.length}`);
    return out;
  }
  const mask = 0x80 >> ((port - 1) & 7);
  if (on) out[idx] |= mask;
  else out[idx] &= ~mask & 0xff;
  return out;
}

export function isPortSet(buf: Uint8Array, port: number): boolean {
  const idx = (port - 1) >> 3;
  if (idx >= buf.length) return false;
  return (buf[idx] & (0x80 >> ((port - 1) & 7))) !== 0;
}

// --- hex helpers (net-snmp returns Buffers; these help with fixtures + logging) ---

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  if (clean.length % 2 !== 0) throw new Error("hex string has odd length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(buf: Uint8Array): string {
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}

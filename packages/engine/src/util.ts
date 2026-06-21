// Pure value-coercion helpers (no transport deps), shared by the SNMP client and the
// write path. Kept separate from snmp.ts so the pure logic stays net-snmp-free and testable.

export function asString(v: unknown): string {
  return Buffer.isBuffer(v) ? v.toString("utf8") : String(v);
}

export function asInt(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

export function asBuffer(v: unknown): Buffer {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  return Buffer.from(String(v));
}

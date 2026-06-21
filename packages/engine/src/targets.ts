// Pure IP target expansion for discovery (no I/O deps, unit-testable offline).
// Accepts: "a.b.c.d/nn" (CIDR), "a.b.c.x-y" (last-octet range), or a single IP.

export function intToIp(n: number): string {
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

export function ipToInt(ip: string): number {
  const p = ip.split(".").map(Number);
  return (((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0);
}

export function expandTargets(spec: string): string[] {
  const s = spec.trim();

  const cidr = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (cidr) {
    const base = ipToInt(`${cidr[1]}.${cidr[2]}.${cidr[3]}.${cidr[4]}`);
    const bits = Number(cidr[5]);
    if (bits < 0 || bits > 32) throw new RangeError(`bad prefix /${bits}`);
    const size = 2 ** (32 - bits);
    const network = (base & ((~(size - 1)) >>> 0)) >>> 0;
    // For /31 and /32 use the whole block; otherwise skip network + broadcast.
    const start = size > 2 ? network + 1 : network;
    const end = size > 2 ? network + size - 2 : network + size - 1;
    const out: string[] = [];
    for (let i = start; i <= end; i++) out.push(intToIp(i >>> 0));
    return out;
  }

  const range = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})-(\d{1,3})$/);
  if (range) {
    const lo = Number(range[4]);
    const hi = Number(range[5]);
    if (hi < lo) throw new RangeError(`bad range ${lo}-${hi}`);
    const out: string[] = [];
    for (let i = lo; i <= hi; i++) out.push(`${range[1]}.${range[2]}.${range[3]}.${i}`);
    return out;
  }

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return [s];
  throw new Error(`unrecognised target spec: ${spec}`);
}

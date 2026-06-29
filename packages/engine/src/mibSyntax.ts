// Phase 3 SPIKE: describeObject — parse one object's OBJECT-TYPE block from its source MIB text.
//
// Why this is needed: net-snmp's ModuleStore (mib.ts) only exposes a reduced ASN.1 base type +
// MAX-ACCESS code per object. It throws away the textual SYNTAX — the inline enumerations, value
// ranges, OCTET STRING size constraints, the TEXTUAL-CONVENTION name, UNITS, and DESCRIPTION — all
// of which the Phase 3 type-aware editor (and a defensible generic SET) need. So we go back to the
// raw MIB text the store already indexed (mib.sourceFor) and parse the object's
// `OBJECT-TYPE … SYNTAX … MAX-ACCESS … [UNITS] … DESCRIPTION … ::= { … }` block ourselves.
//
// Scope (deliberately bounded — see the report for the full do/don't list): inline INTEGER enums,
// INTEGER/Integer32/Unsigned32/Gauge32/Counter/TimeTicks/IpAddress/OBJECT IDENTIFIER, INTEGER
// ranges, OCTET STRING SIZE ranges, BITS, and ONE level of TEXTUAL-CONVENTION resolution (a named
// TC whose definition the store has — same module or an imported module — contributing its
// enum/range/base; TruthValue specifically maps to a boolean true(1)/false(2)). We do NOT attempt
// SEQUENCE/table-row parsing, multi-level TC chains, or full ASN.1.
import type { MibStore } from "./mib.ts";
import type { MibSyntax, MibBaseType, MibEnumValue, ObjectAccess } from "./model.ts";
import { accessFromMaxAccess } from "./objectResolver.ts";

// net-snmp ObjectType codes (numeric, to avoid depending on key names). Mirrors apply.ts/snmp.ts.
const SNMP = {
  Integer: 2,     // also Integer32 / enum
  OctetString: 4,
  OID: 6,
  IpAddress: 64,
  Counter: 65,    // Counter32
  Gauge: 66,      // Gauge32 / Unsigned32
  TimeTicks: 67,
} as const;

// SNMPv2-SMI MAX-ACCESS keyword -> numeric code accepted by accessFromMaxAccess (objectResolver.ts).
const MAX_ACCESS_CODE: Record<string, number> = {
  "not-accessible": 0,
  "accessible-for-notify": 1,
  "read-only": 2,
  "read-write": 3,
  "read-create": 4,
};

/**
 * Describe an object's SYNTAX for the editor + generic SET path. `symbolOrOid` is a MIB symbol
 * (e.g. "rlPhdUnitGenParamMgmtVlanId") or a numeric OID (object or instance OID). Returns null if
 * the object can't be located/parsed so the caller can fall back to a free-text editor.
 */
export function describeObject(mib: MibStore, symbolOrOid: string): MibSyntax | null {
  const src = mib.sourceFor(symbolOrOid);
  if (!src) return null;
  const block = extractObjectTypeBlock(src.text, src.object.name);
  if (!block) return null;

  const syntaxRaw = clauseValue(block, "SYNTAX");
  if (!syntaxRaw) return null;

  const units = stripQuotes(clauseValue(block, "UNITS"));
  const description = stripQuotes(clauseValue(block, "DESCRIPTION"));
  const accessKw = (clauseValue(block, "MAX-ACCESS") ?? clauseValue(block, "ACCESS") ?? "").trim();
  const access: ObjectAccess | undefined = accessKw
    ? accessFromMaxAccess(MAX_ACCESS_CODE[accessKw])
    : undefined;

  const parsed = parseSyntax(syntaxRaw, mib, src.module);
  if (!parsed) return null;

  // Trim to the contract shape, omitting empties so the JSON stays lean.
  const out: MibSyntax = { base: parsed.base, snmpType: parsed.snmpType };
  if (parsed.enums && parsed.enums.length) out.enums = parsed.enums;
  if (parsed.range) out.range = parsed.range;
  if (parsed.sizeRange) out.sizeRange = parsed.sizeRange;
  if (parsed.tc) out.tc = parsed.tc;
  if (units) out.units = units;
  if (description) out.description = description.replace(/\s+/g, " ").trim();
  if (access) out.access = access;
  return out;
}

// ---------------------------------------------------------------------------
// OBJECT-TYPE block extraction
// ---------------------------------------------------------------------------

/**
 * Slice the `<name> OBJECT-TYPE … ::= { … }` definition for `name` out of the module text. We find
 * the symbol followed by OBJECT-TYPE, then take everything up to the first `::= {` (the OID
 * assignment that terminates an OBJECT-TYPE). Returns "" if not found.
 */
function extractObjectTypeBlock(text: string, name: string): string | null {
  // Anchor on the definition (start-of-line-ish "<name> OBJECT-TYPE"), not a mere mention of the
  // symbol in IMPORTS or another object's DESCRIPTION.
  const re = new RegExp(`(^|[^A-Za-z0-9-])${escapeRe(name)}\\s+OBJECT-TYPE\\b`);
  const m = re.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const assign = text.indexOf("::=", start);
  if (assign < 0) return null;
  return text.slice(start, assign);
}

// ---------------------------------------------------------------------------
// Clause extraction within a block
// ---------------------------------------------------------------------------

// Keywords that begin the next clause; used as terminators when reading a clause's value.
const CLAUSE_KEYWORDS = [
  "SYNTAX", "UNITS", "MAX-ACCESS", "ACCESS", "STATUS", "DESCRIPTION",
  "REFERENCE", "INDEX", "AUGMENTS", "DEFVAL", "PIB-REFERENCES", "PIB-TAG",
];

/**
 * Value of a clause keyword within an OBJECT-TYPE block: the text between the keyword and the next
 * clause keyword (or end of block). For DESCRIPTION/REFERENCE this returns the quoted string
 * (caller strips quotes); for SYNTAX it returns the raw type expression.
 */
function clauseValue(block: string, keyword: string): string | null {
  const re = new RegExp(`\\b${escapeRe(keyword)}\\b`);
  const m = re.exec(block);
  if (!m) return null;
  const from = m.index + m[0].length;
  // For quoted clauses (DESCRIPTION/REFERENCE/UNITS) the value is the next "...": take it whole so a
  // clause keyword appearing INSIDE the prose doesn't truncate it.
  const rest = block.slice(from);
  const q = rest.match(/^\s*"([\s\S]*?)"/);
  if (q) return q[1];
  // Otherwise read until the next clause keyword.
  let end = rest.length;
  for (const kw of CLAUSE_KEYWORDS) {
    if (kw === keyword) continue;
    const km = new RegExp(`\\b${escapeRe(kw)}\\b`).exec(rest);
    if (km && km.index < end) end = km.index;
  }
  return rest.slice(0, end).trim();
}

// ---------------------------------------------------------------------------
// SYNTAX parsing
// ---------------------------------------------------------------------------

interface ParsedSyntax {
  base: MibBaseType;
  snmpType: number;
  enums?: MibEnumValue[];
  range?: { min: number; max: number };
  sizeRange?: { min: number; max: number };
  tc?: string;
}

function parseSyntax(raw: string, mib: MibStore, module: string, depth = 0): ParsedSyntax | null {
  const s = raw.replace(/\s+/g, " ").trim();

  // INTEGER / Integer32 with an inline enumeration: INTEGER { up(1), down(2) }.
  if (/^(INTEGER|Integer32)\s*\{/.test(s)) {
    const enums = parseEnumBraces(s);
    if (enums.length) return { base: "enum", snmpType: SNMP.Integer, enums };
  }

  // INTEGER / Integer32 with a value range: INTEGER (0..65535) | Integer32 (1..4094).
  if (/^(INTEGER|Integer32)\s*\(/.test(s)) {
    const range = parseRangeParen(s);
    return { base: "integer", snmpType: SNMP.Integer, range: range ?? undefined };
  }
  if (/^(INTEGER|Integer32)\b/.test(s)) {
    return { base: "integer", snmpType: SNMP.Integer };
  }

  // Unsigned32 / Gauge32 (both map to the Gauge ObjectType code over the wire).
  if (/^(Unsigned32|Gauge32|Gauge)\b/.test(s)) {
    const range = parseRangeParen(s);
    return { base: "unsigned", snmpType: SNMP.Gauge, range: range ?? undefined };
  }

  if (/^(Counter32|Counter64|Counter)\b/.test(s)) {
    return { base: "counter", snmpType: SNMP.Counter };
  }
  if (/^TimeTicks\b/.test(s)) {
    return { base: "timeticks", snmpType: SNMP.TimeTicks };
  }
  if (/^IpAddress\b/.test(s)) {
    return { base: "ipaddress", snmpType: SNMP.IpAddress };
  }
  if (/^OBJECT\s+IDENTIFIER\b/.test(s)) {
    return { base: "oid", snmpType: SNMP.OID };
  }
  if (/^BITS\b/.test(s)) {
    // BITS is encoded as an OCTET STRING on the wire; expose any inline label list as enums.
    const enums = parseEnumBraces(s);
    return { base: "bits", snmpType: SNMP.OctetString, enums: enums.length ? enums : undefined };
  }

  // OCTET STRING, optionally with a SIZE constraint: OCTET STRING (SIZE (0..32)).
  if (/^OCTET\s+STRING\b/.test(s)) {
    const sizeRange = parseSizeParen(s);
    return { base: "string", snmpType: SNMP.OctetString, sizeRange: sizeRange ?? undefined };
  }
  // DisplayString and friends that the store may have left textual are handled via the TC branch.

  // A named type: either a TEXTUAL-CONVENTION (TruthValue, DisplayString, RowStatus, …) or a base
  // type alias. Resolve ONE level (depth-guarded) by finding its definition in the MIBs.
  const named = s.match(/^([A-Za-z][A-Za-z0-9-]*)/);
  if (named) {
    const tc = named[1];
    // TruthValue is ubiquitous and standard: boolean enum true(1)/false(2). Hard-map it so we don't
    // depend on SNMPv2-TC being indexed as a readable file.
    if (tc === "TruthValue") {
      return {
        base: "boolean",
        snmpType: SNMP.Integer,
        tc,
        enums: [
          { label: "true", value: 1 },
          { label: "false", value: 2 },
        ],
      };
    }
    if (depth === 0) {
      const resolved = resolveTextualConvention(tc, mib, module);
      if (resolved) return { ...resolved, tc };
    }
    // Unknown named type we couldn't resolve: treat as an opaque string editor, best-effort.
    return { base: "unknown", snmpType: SNMP.OctetString, tc };
  }

  return null;
}

/**
 * One level of TEXTUAL-CONVENTION resolution. Find the `<name> ::= TEXTUAL-CONVENTION … SYNTAX …`
 * (or a plain `<name> ::= <type>` alias) for `tc` in the object's own module first, then in any
 * module the store has indexed, and parse its SYNTAX (with depth=1 so we don't recurse further).
 */
function resolveTextualConvention(tc: string, mib: MibStore, module: string): ParsedSyntax | null {
  const candidates = [module, ...mib.indexedModules().filter((m) => m !== module)];
  for (const mod of candidates) {
    const text = mib.moduleText(mod);
    if (!text) continue;
    const syntax = extractTcSyntax(text, tc);
    if (syntax) {
      const parsed = parseSyntax(syntax, mib, mod, 1);
      if (parsed) return parsed;
    }
    // The named module may be huge; only the defining module is worth a deep scan. To keep this
    // bounded we stop after the object's own module unless the TC is actually defined there — but
    // since IMPORTS aren't resolved here we do scan others, accepting the first definition found.
  }
  return null;
}

/**
 * Extract the SYNTAX expression of a TEXTUAL-CONVENTION (or a simple type alias) named `tc`.
 *   <tc> ::= TEXTUAL-CONVENTION … SYNTAX <expr> [next-TC | END]
 *   <tc> ::= <expr>                 (a plain alias, e.g. "Foo ::= INTEGER { ... }")
 */
function extractTcSyntax(text: string, tc: string): string | null {
  const re = new RegExp(`(^|[^A-Za-z0-9-])${escapeRe(tc)}\\s*::=\\s*`, "m");
  const m = re.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = text.slice(start);

  if (/^\s*TEXTUAL-CONVENTION\b/.test(rest)) {
    // Pull the SYNTAX clause out of the TC body. The TC body runs until the next "::=" definition.
    const bodyEnd = rest.indexOf("::=");
    const body = bodyEnd < 0 ? rest : rest.slice(0, bodyEnd);
    const sm = /\bSYNTAX\b/.exec(body);
    if (!sm) return null;
    let expr = body.slice(sm.index + sm[0].length);
    // Stop at the next TC clause keyword (DISPLAY-HINT/STATUS/DESCRIPTION/REFERENCE).
    const stop = /\b(DISPLAY-HINT|STATUS|DESCRIPTION|REFERENCE)\b/.exec(expr);
    if (stop) expr = expr.slice(0, stop.index);
    return expr.trim();
  }

  // Plain alias: take the type expression up to the next definition / blank-ish boundary. We grab a
  // bounded window and trim trailing junk; the parseSyntax regexes only consume the leading type.
  const aliasEnd = rest.indexOf("::=");
  const alias = (aliasEnd < 0 ? rest : rest.slice(0, aliasEnd)).trim();
  return alias.length ? alias : null;
}

// ---------------------------------------------------------------------------
// small parsers
// ---------------------------------------------------------------------------

/** Inline enum list: "{ up(1), down(2), testing(3) }" -> [{label,value}, …]. */
function parseEnumBraces(s: string): MibEnumValue[] {
  const open = s.indexOf("{");
  if (open < 0) return [];
  const close = s.indexOf("}", open);
  if (close < 0) return [];
  const inner = s.slice(open + 1, close);
  const out: MibEnumValue[] = [];
  const re = /([A-Za-z][A-Za-z0-9-]*)\s*\(\s*(-?\d+)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner))) out.push({ label: m[1], value: Number(m[2]) });
  return out;
}

/** Value range: "(0..65535)" / "(1..4094)" / "(-128..127)" -> {min,max}. Multi-range -> outer span. */
function parseRangeParen(s: string): { min: number; max: number } | null {
  const open = s.indexOf("(");
  if (open < 0) return null;
  const close = matchParen(s, open);
  if (close < 0) return null;
  const inner = s.slice(open + 1, close);
  return spanOf(inner);
}

/** SIZE constraint: "(SIZE (0..32))" / "(SIZE(0..255))" -> {min,max}. */
function parseSizeParen(s: string): { min: number; max: number } | null {
  const sm = /SIZE\s*\(/.exec(s);
  if (!sm) return null;
  const open = sm.index + sm[0].length - 1;
  const close = matchParen(s, open);
  if (close < 0) return null;
  return spanOf(s.slice(open + 1, close));
}

/** The numeric span across one or more "a..b" / "n" sub-ranges (min of mins, max of maxes). */
function spanOf(inner: string): { min: number; max: number } | null {
  const nums: number[] = [];
  const re = /(-?\d+)(?:\s*\.\.\s*(-?\d+))?/g;
  let m: RegExpExecArray | null;
  let any = false;
  while ((m = re.exec(inner))) {
    any = true;
    nums.push(Number(m[1]));
    nums.push(m[2] !== undefined ? Number(m[2]) : Number(m[1]));
  }
  if (!any) return null;
  return { min: Math.min(...nums), max: Math.max(...nums) };
}

/** Index of the ")" matching the "(" at `open`, honouring nesting. -1 if unbalanced. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function stripQuotes(v: string | null): string | undefined {
  if (v == null) return undefined;
  return v.replace(/^"+|"+$/g, "").trim() || undefined;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

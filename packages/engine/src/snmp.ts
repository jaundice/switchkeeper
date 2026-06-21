// Thin promise-based wrapper over net-snmp. Pure-JS dependency (no native build),
// so it runs identically in Electron, a Docker container, and the MCP host.
import snmp from "net-snmp";
import type { Credential } from "./model.ts";

export interface VarBind {
  oid: string;
  type: number;
  value: unknown;
}

export interface SnmpOptions {
  timeoutMs?: number;
  retries?: number;
}

export class SnmpClient {
  private readonly host: string;
  private readonly cred: Credential;
  private readonly opts: Required<SnmpOptions>;
  private readSession: any;
  private writeSession: any;

  constructor(host: string, cred: Credential, opts: SnmpOptions = {}) {
    this.host = host;
    this.cred = cred;
    this.opts = { timeoutMs: opts.timeoutMs ?? 5000, retries: opts.retries ?? 2 };
    this.readSession = this.makeSession("read");
  }

  /** Build a session: SNMPv3 if the credential is v3, otherwise v2c with the right community. */
  private makeSession(role: "read" | "write") {
    const common = { timeout: this.opts.timeoutMs, retries: this.opts.retries };
    if (this.cred.protocol === "snmpV3" && this.cred.v3) {
      const v = this.cred.v3;
      const level = v.privKey
        ? snmp.SecurityLevel.authPriv
        : v.authKey
          ? snmp.SecurityLevel.authNoPriv
          : snmp.SecurityLevel.noAuthNoPriv;
      const user = {
        name: v.user,
        level,
        authProtocol: v.authProtocol === "sha" ? snmp.AuthProtocols.sha : snmp.AuthProtocols.md5,
        authKey: v.authKey,
        privProtocol: v.privProtocol === "aes" ? snmp.PrivProtocols.aes : snmp.PrivProtocols.des,
        privKey: v.privKey,
      };
      return snmp.createV3Session(this.host, user, common);
    }
    const community = role === "write"
      ? (this.cred.writeCommunity ?? "private")
      : (this.cred.readCommunity ?? "public");
    return snmp.createSession(this.host, community, { version: snmp.Version2c, ...common });
  }

  /** GET one or more scalar OIDs. Throws on transport error; per-varbind errors are kept. */
  get(oids: string[]): Promise<VarBind[]> {
    return new Promise((resolve, reject) => {
      this.readSession.get(oids, (err: Error | null, varbinds: any[]) => {
        if (err) return reject(err);
        resolve(varbinds.map(toVarBind));
      });
    });
  }

  /** Walk a subtree (column or scalar table), returning all non-error varbinds. */
  walk(baseOid: string): Promise<VarBind[]> {
    return new Promise((resolve, reject) => {
      const out: VarBind[] = [];
      this.readSession.subtree(
        baseOid,
        20,
        (varbinds: any[]) => {
          for (const vb of varbinds) {
            if (!snmp.isVarbindError(vb)) out.push(toVarBind(vb));
          }
        },
        (err: Error | null) => (err ? reject(err) : resolve(out)),
      );
    });
  }

  /**
   * Walk a single table column and return a map of row-index (the OID suffix after the
   * column base) -> value.
   */
  async column(columnOid: string): Promise<Map<string, VarBind>> {
    const vbs = await this.walk(columnOid);
    const map = new Map<string, VarBind>();
    const prefix = columnOid.endsWith(".") ? columnOid : columnOid + ".";
    for (const vb of vbs) {
      if (vb.oid.startsWith(prefix)) map.set(vb.oid.slice(prefix.length), vb);
    }
    return map;
  }

  /** SET varbinds using the write community. Caller supplies snmp.ObjectType + value. */
  set(varbinds: { oid: string; type: number; value: unknown }[]): Promise<VarBind[]> {
    if (!this.writeSession) {
      if (this.cred.protocol !== "snmpV3" && !this.cred.writeCommunity) {
        throw new Error("no write community configured");
      }
      this.writeSession = this.makeSession("write");
    }
    return new Promise((resolve, reject) => {
      this.writeSession.set(varbinds, (err: Error | null, vbs: any[]) => {
        if (err) return reject(err);
        resolve(vbs.map(toVarBind));
      });
    });
  }

  close(): void {
    try { this.readSession?.close(); } catch { /* ignore */ }
    try { this.writeSession?.close(); } catch { /* ignore */ }
  }
}

function toVarBind(vb: any): VarBind {
  return { oid: vb.oid, type: vb.type, value: vb.value };
}

// Re-export the bits of net-snmp callers need for typed sets.
export const ObjectType = snmp.ObjectType;
// Value helpers live in util.ts (net-snmp-free); re-exported here for existing importers.
export { asString, asInt, asBuffer } from "./util.ts";

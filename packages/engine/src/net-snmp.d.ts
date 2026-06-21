// Minimal ambient typings for net-snmp (the package ships no declarations and there is
// no @types/net-snmp). Covers only the surface used by snmp.ts.
declare module "net-snmp" {
  export type VarbindCb = (error: Error | null, varbinds: any[]) => void;

  export interface Session {
    get(oids: string[], cb: VarbindCb): void;
    subtree(
      oid: string,
      maxRepetitions: number,
      feedCb: (varbinds: any[]) => void,
      doneCb: (error: Error | null) => void,
    ): void;
    set(varbinds: Array<{ oid: string; type: number; value: unknown }>, cb: VarbindCb): void;
    close(): void;
  }

  export interface V3User {
    name: string;
    level: number;
    authProtocol?: number;
    authKey?: string;
    privProtocol?: number;
    privKey?: string;
  }

  export interface NetSnmp {
    Version1: number;
    Version2c: number;
    Version3: number;
    ObjectType: Record<string, number>;
    SecurityLevel: { noAuthNoPriv: number; authNoPriv: number; authPriv: number };
    AuthProtocols: Record<string, number>;
    PrivProtocols: Record<string, number>;
    createSession(
      target: string,
      community: string,
      options?: Record<string, unknown>,
    ): Session;
    createV3Session(
      target: string,
      user: V3User,
      options?: Record<string, unknown>,
    ): Session;
    isVarbindError(varbind: unknown): boolean;
  }

  const netSnmp: NetSnmp;
  export default netSnmp;
}

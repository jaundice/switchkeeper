// Shared CLI argument parsing -> Credential, so every CLI accepts the same v2c/v3 flags.
//   v2c:  --community public [--write-community private]
//   v3:   --version v3 --v3-user <name> [--v3-auth-proto md5|sha --v3-auth-key <k>]
//                                       [--v3-priv-proto des|aes --v3-priv-key <k>]
import type { Credential } from "./model.ts";

export function argOf(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

export function credentialFromArgs(): Credential {
  const version = argOf("version", "v2c");
  const v3User = argOf("v3-user");
  if (version === "v3" || v3User) {
    return {
      protocol: "snmpV3",
      v3: {
        user: v3User ?? "",
        authProtocol: argOf("v3-auth-proto") as "md5" | "sha" | undefined,
        authKey: argOf("v3-auth-key"),
        privProtocol: argOf("v3-priv-proto") as "des" | "aes" | undefined,
        privKey: argOf("v3-priv-key"),
      },
    };
  }
  return {
    protocol: "snmpV2c",
    readCommunity: argOf("community", "public"),
    writeCommunity: argOf("write-community"),
  };
}

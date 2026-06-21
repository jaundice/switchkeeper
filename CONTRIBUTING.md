# Contributing to Switchkeeper

Thanks for your interest! Switchkeeper exists to keep working network hardware usable, and
the most valuable contributions are **support for more switches** and **field reports** from
real devices.

## Ways to help

- **Add or refine a vendor profile.** Most device-specific behaviour lives in
  [`packages/engine/src/profiles.ts`](./packages/engine/src/profiles.ts), keyed on the SNMP
  enterprise number. If your switch reads but a write/save doesn't behave, a profile tweak is
  usually the fix.
- **Report hardware results.** Open an issue with your switch model, what worked, and what
  didn't (see the hardware-report issue template). Even "reads fine, didn't try writes" is
  useful for the support matrix.
- **File bugs and feature requests** using the issue templates.
- **Improve docs, the UI, or the engine.**

## Development setup

Requires **Node ≥ 22.18** (the project runs `.ts` directly via Node's native type stripping —
there is no build step for tests or the server).

```bash
git clone https://github.com/jaundice/switchkeeper.git
cd switchkeeper
npm install
npm test            # engine unit tests (offline; no hardware needed)
```

Useful entry points:

- `node packages/engine/src/cli.ts --host <ip> --community public` — read-only probe.
- `node packages/mcp/src/server.ts --http 7341` — server with web UI, REST API, and MCP.
- `npm run start --workspace @switchkeeper/desktop` — Electron app.

## Working with real switches safely

- The engine defaults to **read-only**. Writes require explicit write credentials.
- Test writes against a **non-production** switch. Keep console/serial access as a fallback.
- The apply path plans, writes, re-reads, and verifies; please don't bypass it.
- Never commit real credentials, internal hostnames, or private IPs. Use example values
  (`192.168.1.x`, `example.com`, community `public`/`private`).

## Pull requests

1. Keep changes focused; one logical change per PR.
2. Run `npm test` and make sure it passes. Add tests for new engine logic where practical —
   the PortList codec and apply planner have offline unit tests to model after.
3. Describe what device/scenario you tested against.
4. By contributing you agree your work is licensed under the project's [MIT License](./LICENSE).

## Code style

Match the surrounding code. The engine is dependency-light, ASCII-only in source (Node's
type stripper rejects some non-ASCII characters), and favours small, composable functions.

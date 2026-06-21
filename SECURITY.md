# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, report privately via GitHub's
[security advisories](https://github.com/jaundice/switchkeeper/security/advisories/new)
("Report a vulnerability"). Include affected version/commit, a description, reproduction
steps, and impact. We'll acknowledge as soon as we can and keep you updated on a fix.

## Scope and context

Switchkeeper manages network switches over SNMP. Some inherent considerations:

- **SNMPv2c community strings are sent in clear text** over the network. Prefer **SNMPv3**
  (auth + priv) where your hardware supports it, and restrict SNMP to a management VLAN.
- The server exposes a web UI, REST API (`/api/*`), and MCP endpoint (`/mcp`) with **no
  built-in authentication**. Do not expose it directly to untrusted networks — run it behind
  a reverse proxy that enforces authentication and TLS (see `deploy/`), or bind it to a
  trusted interface only.
- Switchkeeper never stores credentials; they're supplied per request and used to talk to the
  switch. Treat any host running the server as having the access its callers provide.

## Supported versions

This project is pre-1.0; security fixes are applied to the latest release and `main`.

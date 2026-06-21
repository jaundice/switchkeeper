#!/usr/bin/env bash
# In-container setup for the Switchkeeper MCP server (run inside the LXC).
# Installs Node 22, installs prod deps, and runs the MCP as a systemd service over HTTP.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "[setup] apt prerequisites"
apt-get update -qq
apt-get install -y -qq curl ca-certificates >/dev/null

NODE_MAJOR="$(command -v node >/dev/null 2>&1 && node -v | sed -E 's/^v([0-9]+).*/\1/' || echo 0)"
if [ "${NODE_MAJOR}" -lt 22 ]; then
  echo "[setup] installing Node 22 (have major ${NODE_MAJOR})"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "[setup] node $(node -v)"

echo "[setup] npm install (prod deps)"
cd /opt/switchkeeper
npm install --omit=dev --no-audit --no-fund >/dev/null

echo "[setup] systemd unit"
cat > /etc/systemd/system/switchkeeper-mcp.service <<'UNIT'
[Unit]
Description=Switchkeeper MCP server (SNMP switch management over MCP)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/switchkeeper
ExecStart=/usr/bin/node /opt/switchkeeper/packages/mcp/src/server.ts --http 7341
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable switchkeeper-mcp >/dev/null 2>&1
systemctl restart switchkeeper-mcp
sleep 3
systemctl is-active switchkeeper-mcp && echo "[setup] DONE"

# Switchkeeper server image: serves the web UI (/), JSON API (/api), and MCP (/mcp).
# Runs the TypeScript sources directly on Node 22 (native type stripping), same as the LXC.
FROM node:22-alpine

WORKDIR /app

# Install production deps first (better layer caching). Workspace package.json files only.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/engine/package.json packages/engine/package.json
COPY packages/mcp/package.json packages/mcp/package.json
COPY packages/desktop/package.json packages/desktop/package.json
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund

# App sources (the server reads the renderer from packages/desktop/renderer).
COPY packages/engine packages/engine
COPY packages/mcp packages/mcp
COPY packages/desktop/renderer packages/desktop/renderer

ENV NODE_ENV=production
EXPOSE 7341
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s \
  CMD wget -qO- http://localhost:7341/health || exit 1

CMD ["node", "packages/mcp/src/server.ts", "--http", "7341"]

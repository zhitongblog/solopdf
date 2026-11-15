# Dockerfile for MCP registry health checks & containerized stdio usage (Glama, Smithery, etc.).
# Builds @solopdf/core and launches the 56-tool SoloPDF MCP server over stdio.

FROM node:22-bookworm-slim
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY app/package.json ./app/
COPY cli/package.json ./cli/
COPY core/package.json ./core/
COPY dev-mcp/package.json ./dev-mcp/

RUN pnpm install --filter @solopdf/core --filter @solopdf/dev-mcp --frozen-lockfile

COPY core/ ./core/
RUN pnpm --filter @solopdf/core build

COPY dev-mcp/ ./dev-mcp/

ENTRYPOINT ["node", "/app/dev-mcp/src/index.mjs"]

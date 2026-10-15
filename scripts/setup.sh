#!/bin/bash
set -e

# Absolute path to this checkout, so the generated config runs the fork's
# compiled server instead of the upstream npm package
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

bun install

# Compile the MCP server to dist/ — both MCP configs run dist/server.js
bun run build

# Cursor: write .cursor/mcp.json (gitignored, so an absolute path is fine)
mkdir -p "$REPO_ROOT/.cursor"
cat > "$REPO_ROOT/.cursor/mcp.json" <<EOF
{
  "mcpServers": {
    "TalkToFigma": {
      "command": "bun",
      "args": [
        "$REPO_ROOT/dist/server.js"
      ]
    }
  }
}
EOF
echo "✓ Cursor MCP config written to .cursor/mcp.json"

# Claude Code: .mcp.json is committed and already points at the local server
echo "✓ Claude Code uses the committed .mcp.json (runs dist/server.js)"

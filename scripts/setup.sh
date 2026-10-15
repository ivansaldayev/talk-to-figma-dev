#!/bin/bash

# Absolute path to this checkout, so the generated config runs the fork's
# server from source instead of the upstream npm package
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

bun install

# Cursor: write .cursor/mcp.json (gitignored, so an absolute path is fine)
mkdir -p "$REPO_ROOT/.cursor"
cat > "$REPO_ROOT/.cursor/mcp.json" <<EOF
{
  "mcpServers": {
    "TalkToFigma": {
      "command": "bun",
      "args": [
        "$REPO_ROOT/src/talk_to_figma_mcp/server.ts"
      ]
    }
  }
}
EOF
echo "✓ Cursor MCP config written to .cursor/mcp.json"

# Claude Code: .mcp.json is committed and already points at the local server
echo "✓ Claude Code uses the committed .mcp.json (runs src/talk_to_figma_mcp/server.ts)"

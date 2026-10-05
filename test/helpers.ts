import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function fakeHome(repoRoot: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-home-"));
  fs.mkdirSync(path.join(home, ".claude"));
  fs.writeFileSync(path.join(home, ".claude", "CLAUDE.md"), "# Kişisel\n- Türkçe yorum yaz\n");
  fs.writeFileSync(
    path.join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: { github: { command: "gh-mcp" } },
      projects: { [repoRoot]: { mcpServers: { "my-app-memory": { type: "stdio", command: "node", args: ["/x/mcp-qdrant-memory/dist/index.js"], env: { QDRANT_COLLECTION_NAME: "my-app" } } } } },
    }),
  );
  return home;
}


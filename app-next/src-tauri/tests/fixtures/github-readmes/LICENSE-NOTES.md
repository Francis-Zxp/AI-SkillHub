# README excerpts used by `mcp_github_import` tests (G1)

These files keep only short configuration snippets of the kind each project's
README shows, so the parser can be tested without network access. They are
excerpts for testing, not copies of the READMEs, and the prose around the
snippets is not reproduced.

| File | Upstream | License |
|---|---|---|
| `github-mcp-server.md` | https://github.com/github/github-mcp-server | MIT |
| `playwright-mcp.md` | https://github.com/microsoft/playwright-mcp | Apache-2.0 |
| `servers-memory.md` | https://github.com/modelcontextprotocol/servers (src/memory) | MIT |
| `context7.md` | https://github.com/upstash/context7 | MIT |

The snippets were written to match the shapes those READMEs use (VS Code
`servers` with `${input:…}`, Docker, `npx`, `cmd /c npx`, remote URL with a
placeholder header). Nothing here is executed by the tests or by the app.

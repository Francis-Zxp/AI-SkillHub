// The Origin MCP recipe installs a verified package pair into its own venv.
// origin-mcp 0.1.4 accepts any mcp>=1.8, and mcp 2.x breaks it at import, so
// the SDK must stay pinned and a mismatched runtime must be repaired.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const recipe = await readFile(new URL("../src-tauri/src/mcp_recipes.rs", import.meta.url), "utf8");

test("origin recipe pins origin-mcp and a verified MCP SDK 1.x", () => {
  assert.match(recipe, /pub\(crate\) const ORIGIN_MCP_VERSION: &str = "0\.1\.4";/);
  assert.match(recipe, /pub\(crate\) const ORIGIN_MCP_SDK_VERSION: &str = "1\.\d+\.\d+";/);
  assert.match(recipe, /&format!\("origin-mcp==\{ORIGIN_MCP_VERSION\}"\),\s*&format!\("mcp==\{ORIGIN_MCP_SDK_VERSION\}"\),/);
});

test("a runtime with another SDK is not ready and is repaired by installing", () => {
  assert.match(recipe, /let runtime_ready = installed == ORIGIN_MCP_VERSION && sdk == ORIGIN_MCP_SDK_VERSION;/);
  assert.match(recipe, /\} else if !runtime_ready \{\s*\("not-installed", "install"\)/);
  assert.match(recipe, /if installed != ORIGIN_MCP_VERSION \|\| sdk != ORIGIN_MCP_SDK_VERSION \{/);
});

test("the recipe runs only Python, pip and origin-mcp, never a shell", () => {
  assert.doesNotMatch(recipe, /Command::new\("(?:cmd|powershell|pwsh|bash)(?:\.exe)?"\)/);
  assert.match(recipe, /arg\("venv"\)/);
});

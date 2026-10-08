// Test-only fake MCP server for mcp_probe.rs (T2/T3). Never shipped, never
// run by the app. It logs every JSON-RPC method it receives to FAKE_MCP_LOG,
// starts one long-lived grandchild so the test can check the process tree is
// killed, and answers initialize / tools/list unless FAKE_MCP_SILENT is set.
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const log = process.env.FAKE_MCP_LOG;
const silent = process.env.FAKE_MCP_SILENT === "1";
const note = (line) => {
  if (log) appendFileSync(log, `${line}\n`);
};

note(`pid ${process.pid}`);
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
note(`pid ${grandchild.pid}`);

// A non-JSON banner line must be ignored by the client.
process.stdout.write("fake MCP server ready\n");

const reply = (id, result) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
};

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method) note(`method ${message.method}`);
  if (silent || message.id === undefined) return;
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "fake", version: "1.0.0" },
    });
  } else if (message.method === "tools/list") {
    reply(message.id, { tools: [{ name: "alpha" }, { name: "beta" }] });
  } else {
    reply(message.id, {});
  }
});

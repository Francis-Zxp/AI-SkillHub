// v3.3: the MCP page lives in src/mcp (docs/v3.3/mcp-contract.md §0.3, §6). This re-export keeps
// App.tsx's lazy import (`import("./McpCenter").then(module => module.McpCenter)`) unchanged.
export { McpPage as McpCenter } from "./mcp/McpPage";
export type { McpPageProps as McpCenterProps } from "./mcp/McpPage";

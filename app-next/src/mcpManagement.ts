export type WritableMcpHostId = "host-codex" | "host-claude-code";
export type WritableMcpScope = "user" | "project" | "local";

export type McpManagementBlockReason =
  | "desktop-only"
  | "unsupported"
  | "invalid-name"
  | "location-unknown"
  | "parse-failed"
  | "workspace-missing";

export type McpManagementBindingInput = {
  hostId: string;
  nativeScope: string;
  nativeName: string;
  workspaceId?: string | null;
};

export type McpManagementLocationInput = {
  hostId: string;
  nativeScope: string;
  parseStatus: string;
  workspaceId?: string | null;
};

export type McpManagementDecision =
  | {
      writable: true;
      hostId: WritableMcpHostId;
      scope: WritableMcpScope;
      workspaceId?: string;
    }
  | { writable: false; reason: McpManagementBlockReason };

const CLAUDE_RESERVED_MCP_SERVER_NAMES = new Set([
  "workspace",
  "claude-in-chrome",
  "computer-use",
  "claude preview",
  "claude browser"
]);

export function evaluateMcpBindingManagement(
  binding: McpManagementBindingInput,
  location: McpManagementLocationInput | null,
  runtimeAvailable: boolean
): McpManagementDecision {
  if (!runtimeAvailable) return { writable: false, reason: "desktop-only" };
  const hostId = writableHostId(binding.hostId);
  const scope = writableScope(binding.nativeScope);
  const hostScopeSupported = hostId === "host-codex"
    ? scope === "user" || scope === "project"
    : hostId === "host-claude-code"
      ? scope === "user" || scope === "project" || scope === "local"
      : false;
  if (!hostId || !scope || !hostScopeSupported) {
    return { writable: false, reason: "unsupported" };
  }
  if (!mcpServerNameCompatible(binding.nativeName, [hostId])) {
    return { writable: false, reason: "invalid-name" };
  }
  if (!location || location.hostId !== hostId) {
    return { writable: false, reason: "location-unknown" };
  }
  if (!mcpLocationScopeCompatible(hostId, scope, location.nativeScope)) {
    return { writable: false, reason: "unsupported" };
  }
  if (location.parseStatus !== "ok") {
    return { writable: false, reason: "parse-failed" };
  }
  const workspaceId = binding.workspaceId?.trim() || location.workspaceId?.trim() || undefined;
  if (scope !== "user" && !workspaceId) {
    return { writable: false, reason: "workspace-missing" };
  }
  return {
    writable: true,
    hostId,
    scope,
    workspaceId: scope === "user" ? undefined : workspaceId
  };
}

export function mcpServerNameCompatible(serverName: string, hostIds: string[]) {
  const includesClaude = hostIds.includes("host-claude-code");
  if (includesClaude && CLAUDE_RESERVED_MCP_SERVER_NAMES.has(serverName.toLowerCase())) return false;
  const pattern = includesClaude
    ? /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
    : /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  return pattern.test(serverName);
}

export function mcpLocationScopeCompatible(
  hostId: WritableMcpHostId,
  bindingScope: WritableMcpScope,
  locationScope: string
) {
  if (hostId === "host-codex") {
    return (bindingScope === "user" && locationScope === "user")
      || (bindingScope === "project" && locationScope === "project");
  }
  return ((bindingScope === "user" || bindingScope === "local") && locationScope === "user/local")
    || (bindingScope === "project" && locationScope === "project");
}

export function containsObviousCredentialValue(value: string) {
  const keyValueSecret = /(?:^|[\s,{])(?:--)?(?:[A-Za-z0-9_]*_)?(?:api[_-]?key|token|secret|password|passwd|authorization)\s*(?:=|:)\s*["']?\S+/im;
  const commonTokenPrefix = /(?:^|[^A-Za-z0-9])(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/i;
  if (keyValueSecret.test(value) || commonTokenPrefix.test(value)) return true;

  const argumentsByLine = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const secretFlag = /^--?(?:api[-_]?key|token|secret|password|passwd|authorization)$/i;
  return argumentsByLine.some((argument, index) =>
    secretFlag.test(argument)
    && Boolean(argumentsByLine[index + 1])
    && !argumentsByLine[index + 1].startsWith("-")
  );
}

function writableHostId(value: string): WritableMcpHostId | null {
  if (value === "host-codex" || value === "host-claude-code") return value;
  return null;
}

function writableScope(value: string): WritableMcpScope | null {
  if (value === "user" || value === "project" || value === "local") return value;
  return null;
}

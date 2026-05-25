CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL,
  url TEXT,
  local_path TEXT,
  install_mode TEXT NOT NULL DEFAULT 'scan',
  category_id TEXT NOT NULL DEFAULT 'auto',
  note TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  source_id TEXT,
  name TEXT NOT NULL,
  folder_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category_id TEXT NOT NULL DEFAULT 'auto',
  health_status TEXT NOT NULL DEFAULT 'info',
  health_summary TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  relative_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(source_id) REFERENCES sources(id)
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  skills_path TEXT NOT NULL,
  detected INTEGER NOT NULL DEFAULT 0,
  managed INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_adapters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  vendor TEXT NOT NULL DEFAULT '',
  skills_path_hint TEXT NOT NULL DEFAULT '',
  detection_kind TEXT NOT NULL DEFAULT 'folder',
  install_scope TEXT NOT NULL DEFAULT 'global',
  capability_level TEXT NOT NULL DEFAULT 'skills',
  docs_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'not-detected',
  detected INTEGER NOT NULL DEFAULT 0,
  managed INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL,
  path TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_agents (
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(workspace_id, agent_id),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY(agent_id) REFERENCES agents(id)
);

CREATE TABLE IF NOT EXISTS presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS preset_skills (
  preset_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  PRIMARY KEY(preset_id, skill_id),
  FOREIGN KEY(preset_id) REFERENCES presets(id),
  FOREIGN KEY(skill_id) REFERENCES skills(id)
);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS skill_tags (
  skill_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  PRIMARY KEY(skill_id, tag_id),
  FOREIGN KEY(skill_id) REFERENCES skills(id),
  FOREIGN KEY(tag_id) REFERENCES tags(id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS adapter_safety_checks (
  id TEXT PRIMARY KEY,
  adapter_id TEXT NOT NULL,
  check_key TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(adapter_id) REFERENCES agent_adapters(id)
);

CREATE TABLE IF NOT EXISTS adapter_capabilities (
  id TEXT PRIMARY KEY,
  adapter_id TEXT NOT NULL,
  capability_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(adapter_id) REFERENCES agent_adapters(id)
);

CREATE TABLE IF NOT EXISTS project_scans (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  path TEXT NOT NULL,
  has_git INTEGER NOT NULL DEFAULT 0,
  has_package_json INTEGER NOT NULL DEFAULT 0,
  has_cargo_toml INTEGER NOT NULL DEFAULT 0,
  has_tauri_config INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  scanned_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
);

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const backend = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const universe = await readFile(new URL("../src/SkillUniverse.tsx", import.meta.url), "utf8");
const i18n = await readFile(new URL("../src/i18n.ts", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("Skill folders are SQLite metadata and never move or delete Skill files", () => {
  assert.match(backend, /CREATE TABLE IF NOT EXISTS skill_folders/);
  assert.match(backend, /CREATE TABLE IF NOT EXISTS skill_folder_memberships/);
  assert.match(backend, /CREATE TABLE IF NOT EXISTS source_folder_memberships/);
  assert.match(backend, /ON CONFLICT\(source_id\) DO UPDATE SET/);
  assert.match(backend, /skillsDeleted": 0/);
  const folderCommands = backend.match(/fn (?:create|update|delete|move)_skill_folder[\s\S]*?(?=\n#\[tauri::command\]|\nfn require_skill_folder)/g)?.join("\n") ?? "";
  assert.doesNotMatch(folderCommands, /remove_dir|remove_file|rename\(|fs::copy/);
});

test("library supports drag, accessible select fallback and safe unfiling", () => {
  assert.match(app, /application\/x-ai-skillhub-skill-id/);
  assert.match(app, /application\/x-ai-skillhub-source-id/);
  assert.match(app, /source-folder-drag-handle/);
  assert.match(app, /<Icon name="grip"/);
  assert.match(app, /folders\.dragShort/);
  assert.match(app, /showPicker/);
  assert.match(app, /else select\?\.click\(\)/);
  assert.match(app, /aria-haspopup="listbox"/);
  assert.match(app, /role="button"/);
  assert.match(app, /<select[\s\S]*folders\.choose/);
  assert.match(app, /skillMatchesUserFolder/);
  assert.match(app, /delete_skill_folder/);
  assert.match(i18n, /Skill 不会删除，只会回到/);
  assert.match(app, /skill-folder-manage/);
  assert.doesNotMatch(app, /skill-folder-item-actions/);
  assert.match(app, /className="skill-folder-manage"[\s\S]*?onClick=\{\(\) => openEdit\(folder\)\}[\s\S]*?type="button"/);
  assert.match(app, /onMove\(editingId, "up"\)/);
  assert.match(app, /onMove\(editingId, "down"\)/);
  assert.match(app, /SKILL_FOLDER_COLOR_HEX/);
  assert.match(styles, /background: var\(--folder-tone\) !important/);
  assert.match(styles, /\.skill-folder-strip \{[\s\S]*?grid-template-columns: repeat\(auto-fit/);
  const folderStripStyles = styles.match(/\.skill-folder-strip \{([^}]*)\}/)?.[1] ?? "";
  assert.doesNotMatch(folderStripStyles, /overflow-x:\s*auto/);
  assert.match(styles, /\.skill-folder-item \{[\s\S]*?position: relative/);
  assert.match(styles, /\.skill-folder-item > \.skill-folder-target \{[\s\S]*?padding-right: calc\(44px/);
  assert.match(styles, /\.skill-folder-manage \{[\s\S]*?position: absolute[\s\S]*?top: var\(--space-2\)[\s\S]*?right: var\(--space-2\)[\s\S]*?width: 44px[\s\S]*?height: 44px/);
  assert.match(styles, /\.source-folder-drag-handle \{[\s\S]*?min-width: 44px[\s\S]*?min-height: 44px/);
  assert.match(styles, /\.skill-folder-editor \.folder-color-dot,[\s\S]*?width: 44px[\s\S]*?height: 44px/);
  assert.match(styles, /source-group-title strong[\s\S]*?-webkit-line-clamp: 2/);
});

test("the All filter cannot accept a classification drop", () => {
  assert.match(app, /const acceptsDrop = id !== "all"/);
  assert.match(app, /onDrop=\{acceptsDrop \? event => acceptDrop/);
});

test("import draft retains a folder and can create a custom classification during add", () => {
  const draftType = app.match(/type ImportWizardDraft = \{([\s\S]*?)\n\};/)?.[1] ?? "";
  assert.match(draftType, /folderId: string/);
  assert.match(draftType, /customFolderName: string/);
  assert.match(app, /move_source_skills_to_folder/);
  assert.match(app, /CREATE_IMPORT_FOLDER_VALUE/);
  assert.match(app, /onCreateFolder\(requestedName, "", "cyan"\)/);
  assert.match(app, /onMoveSourceSkillsToFolder\(promotedSource\.id, resolvedFolderId\)/);
  assert.match(i18n, /新建自定义分类文件夹/);
});

test("homepage folder mode only reflects user folders and keeps unassigned Skills together", () => {
  assert.match(universe, /if \(skill\.userFolderName\)/);
  assert.match(universe, /return `folder:\$\{skill\.userFolderColor/);
  assert.match(universe, /return `folder:slate:\$\{t\("folders\.unfiled"\)\}`/);
  assert.doesNotMatch(universe, /return match\?\.category \?\? "general"/);
  assert.match(i18n, /"universe\.mode\.categories": "我的文件夹"/);
});

test("source identity is exact and a generic repository named skills cannot absorb other children", () => {
  assert.match(backend, /source_id: String/);
  assert.match(app, /if \(skill\.sourceId\) return skill\.sourceId === source\.id/);
  assert.doesNotMatch(app, /skillPathSegments\.includes\(sourceFolder\)/);
  assert.match(universe, /if \(skill\.sourceId\)/);
  assert.doesNotMatch(universe, /path\.includes\(`\/\$\{normalize\(source\.name\)\}\/`\)/);
  assert.match(backend, /github_source_storage_name/);
  assert.match(backend, /format!\("\{\}--\{\}"/);
});

test("large source trees render incrementally and folder edits keep whole-tree semantics", () => {
  assert.match(app, /const childLimit = childLimits\[source\.id\] \?\? 36/);
  assert.match(app, /visibleChildSkills = childSkills\.slice\(0, childLimit\)/);
  assert.match(app, /folders\.sourceTreeFolder/);
  assert.match(app, /inherited-folder-chip/);
  assert.match(backend, /future children inherit without materialized rows/);
  assert.match(backend, /fn create_skill_folder\([\s\S]*?Result<Vec<SkillFolderCard>, String>/);
  assert.match(app, /invoke<SkillFolderCard\[\]>/);
  assert.match(app, /applySkillFolderCommandResult/);
  assert.match(app, /const unfiledCount = useMemo/);
});

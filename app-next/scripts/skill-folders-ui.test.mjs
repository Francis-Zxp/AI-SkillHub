import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readAppSource } from "./app-source.mjs";

const app = await readAppSource();
const skyModel = await readFile(new URL("../src/skyIslandModel.ts", import.meta.url), "utf8");
const backend = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const universe = await readFile(new URL("../src/SkillUniverse.tsx", import.meta.url), "utf8");
const i18n = await readFile(new URL("../src/i18n.ts", import.meta.url), "utf8");
const types = await readFile(new URL("../src/types.ts", import.meta.url), "utf8");
const tauriConfig = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));

test("Skill folders are SQLite metadata and never move or delete Skill files", () => {
  assert.match(backend, /CREATE TABLE IF NOT EXISTS skill_folders/);
  assert.match(backend, /CREATE TABLE IF NOT EXISTS skill_folder_memberships/);
  assert.match(backend, /CREATE TABLE IF NOT EXISTS source_folder_memberships/);
  assert.match(backend, /ON CONFLICT\(source_id\) DO UPDATE SET/);
  assert.match(backend, /skillsDeleted": 0/);
  const folderCommands = backend.match(/fn (?:create|update|delete|move)_skill_folder[\s\S]*?(?=\n#\[tauri::command\]|\nfn require_skill_folder)/g)?.join("\n") ?? "";
  assert.doesNotMatch(folderCommands, /remove_dir|remove_file|rename\(|fs::copy/);
});

test("library moves rows into folders with a pointer grip and an accessible menu alternative", () => {
  // v3.3 §3.9: native file drop is on, which disables HTML5 drag inside the webview, so internal
  // moves are pointer drags from a grip; "⋯ → 移到文件夹…" is the keyboard-accessible path.
  assert.equal(tauriConfig.app.windows[0].dragDropEnabled, true);
  assert.doesNotMatch(app, /draggable=/);
  assert.doesNotMatch(app, /dataTransfer\.setData/);
  assert.ok(app.includes('className="lib-grip" onPointerDown='));
  assert.ok(app.includes('<Icon name="grip" />'));
  assert.ok(app.includes('window.addEventListener("pointermove", move)'));
  assert.ok(app.includes('window.addEventListener("pointercancel", cancel)'));
  assert.ok(app.includes('key: "move", label: t("v33.moveToFolder")'));
  assert.ok(app.includes('testId="move-folder-dialog"'));
  assert.ok(app.includes('window.addEventListener("dragover", preventExternalDropNavigation)'));
  assert.ok(app.includes('window.addEventListener("drop", preventExternalDropNavigation)'));
  assert.ok(app.includes('type === "Files" || type === "text/plain" || type === "text/uri-list"'));
  assert.ok(app.includes("delete_skill_folder"));
  assert.ok(app.includes("update_skill_folder"));
  assert.ok(app.includes("testId={`folder-chip-${folder.id}`}"));
});

test("the All chip cannot accept a classification drop", () => {
  assert.ok(app.includes('if (over === undefined || over === "all") return;'));
  assert.ok(app.includes('dropId="all"'));
  assert.ok(app.includes('const destination = over === "unfiled" ? "" : over;'));
});

test("adding a source can file it into an existing or a new folder", () => {
  // v3.3 §6.4 "更多选项": the folder (incl. 新建) travels in the one install request.
  assert.ok(app.includes('<option value={NEW_FOLDER}>{t("v33.folderNewOption")}</option>'));
  assert.ok(app.includes("folderId: folderId && folderId !== NEW_FOLDER ? folderId : null"));
  assert.ok(app.includes("newFolderName: folderId === NEW_FOLDER && newFolderName.trim() ? newFolderName.trim() : null"));
  assert.match(types, /newFolderName: string \| null;/);
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
  assert.match(skyModel, /if \(skill\.sourceId\) return skill\.sourceId === source\.id/);
  assert.match(app, /return modelSkillBelongsToSource\(skill, source\)/);
  assert.doesNotMatch(app, /skillPathSegments\.includes\(sourceFolder\)/);
  assert.match(universe, /if \(skill\.sourceId\)/);
  assert.doesNotMatch(universe, /path\.includes\(`\/\$\{normalize\(source\.name\)\}\/`\)/);
  assert.match(backend, /github_source_storage_name/);
  assert.match(backend, /format!\("\{\}--\{\}"/);
});

test("large libraries render a window of rows and folder edits keep whole-tree semantics", () => {
  assert.ok(app.includes("const CHILD_PAGE = 40;"));
  assert.ok(app.includes("row.skills.slice(0, CHILD_PAGE)"));
  assert.ok(app.includes("const WINDOW_THRESHOLD = 80;"));
  assert.ok(app.includes("function useWindow(items: ListItem[]"));
  assert.ok(app.includes("items.slice(window_.start, window_.end)"));
  assert.match(backend, /future children inherit without materialized rows/);
  assert.match(backend, /fn create_skill_folder\([\s\S]*?Result<Vec<SkillFolderCard>, String>/);
  assert.ok(app.includes("invoke<SkillFolderCard[]>"));
  assert.ok(app.includes("setSnapshot(current => current ? applySkillFolderCommandResult(current, command, args, folders) : current)"));
  assert.ok(app.includes("if (mutationBlockedBySync()) return null"));
  assert.ok(app.includes('countSkills(library, { folderId: "unfiled" }).skills'));
});

test("install sends name, folder, category, tags and note in one request", () => {
  // v3.3: no follow-up writes after an install, so nothing can half-apply.
  const sheet = app.slice(app.indexOf("export function ImportSheet"), app.indexOf("function ProbePreview"));
  assert.equal((sheet.match(/await installSkillSource\(/g) ?? []).length, 1);
  assert.ok(sheet.includes("displayName: name.trim() && name.trim() !== probe.displayName ? name.trim() : null"));
  assert.ok(sheet.includes("categoryId: category || null"));
  assert.ok(sheet.includes("tags: parseTagInput(tags)"));
  assert.ok(sheet.includes("note: note.trim() ? note.trim() : null"));
  assert.doesNotMatch(sheet, /onSaveSourceMetadata|onMoveSourceSkillsToFolder|syncAndRefreshAll/);
  assert.ok(sheet.includes('setPhase({ kind: "failed", error: normalized })'));
});

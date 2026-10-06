// Launch through v3.2.18-client-detection-qa.ps1. All application state and
// installation evidence are fixtures in TEMP; no client executable is run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const required = name => { assert.ok(process.env[name], `${name} required`); return process.env[name]; };
const qaRoot = path.resolve(required('AI_SKILLHUB_QA_ROOT'));
const dataRoot = path.resolve(required('AI_SKILLHUB_QA_DATA_ROOT'));
const profile = path.resolve(required('USERPROFILE'));
const reportPath = required('AI_SKILLHUB_QA_REPORT');
const comparable = value => path.toNamespacedPath(path.resolve(value)).toLowerCase();
const inside = (base, value) => { const relative = path.relative(comparable(base), comparable(value)); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
assert.ok(inside(process.env.TEMP, qaRoot));
for (const location of [dataRoot, profile, required('AI_SKILLHUB_EXPECTED_EXE_PATH')]) assert.ok(inside(qaRoot, location), 'Only sandbox paths are permitted');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = {
  executable: required('AI_SKILLHUB_EXPECTED_EXE_PATH'), sha256: required('AI_SKILLHUB_EXPECTED_EXE_SHA256'),
  isolatedRoot: qaRoot, mode: 'real-compiled-tauri-ipc',
  note: 'Fake WorkBuddyAI install in TEMP, native .workbuddy-ai profile, no client execution or upstream network.', checks: []
};
assert.equal(hash(report.executable), report.sha256);
const record = (name, details = true) => { report.checks.push({ name, details }); console.log(`PASS ${name}`); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); };
const personal = path.join(profile, '.workbuddy-ai', 'skills', 'personal-skill', 'SKILL.md');
const codeBuddy = path.join(profile, '.codebuddy', 'skills', 'personal-skill', 'SKILL.md');
const preserved = new Map([personal, codeBuddy].map(file => [file, hash(file)]));
const clientRoot = path.join(profile, '.workbuddy-ai', 'skills');
const child = path.join(dataRoot, 'sources', 'qa-client-pack', 'qa-child', 'SKILL.md');
const childBody = fs.readFileSync(child, 'utf8');
const expandProfile = value => value.replace(/^~(?=[\\/]|$)/, profile);
const adapterIds = ['claude', 'codex', 'antigravity', 'workbuddy', 'cursor', 'gemini-cli', 'opencode', 'github-copilot', 'windsurf', 'kiro', 'hermes', 'openclaw', 'amp', 'coze'];
function verifySnapshot(snapshot, managed) {
  assert.ok(inside(qaRoot, snapshot.root));
  assert.ok(inside(dataRoot, snapshot.sourcesDir));
  assert.deepEqual(snapshot.agentAdapters.map(adapter => adapter.id).sort(), [...adapterIds].sort());
  const agent = snapshot.agents.find(agent => agent.name === 'WorkBuddy');
  assert.ok(agent?.detected, 'WorkBuddy must be detected from its installed fixture');
  assert.equal(comparable(expandProfile(agent.path)), comparable(clientRoot), 'Native product profile must be used');
  const adapter = snapshot.agentAdapters.find(adapter => adapter.id === 'workbuddy');
  assert.ok(adapter.detected);
  if (managed) { assert.ok(agent.managed); assert.ok(adapter.managed); assert.equal(adapter.status, 'ready'); }
  return { detected: agent.detected, managed: agent.managed, path: agent.path, adapterCount: snapshot.agentAdapters.length };
}
function deliveredEntries() {
  return fs.readdirSync(clientRoot).filter(name => name !== 'personal-skill').sort()
    .map(name => ({ name, file: path.join(clientRoot, name, 'SKILL.md') })).filter(entry => fs.existsSync(entry.file));
}
function verifyFiles() {
  for (const [file, before] of preserved) assert.equal(hash(file), before, `${file} must remain unchanged`);
  assert.equal(fs.readFileSync(child, 'utf8'), childBody);
  assert.deepEqual(fs.readdirSync(path.join(profile, '.codebuddy', 'skills')), ['personal-skill'], 'No WorkBuddy entries may leak into CodeBuddy');
  assert.ok(!fs.existsSync(path.join(profile, '.workbuddy')), 'Large product.json must not fall back to the legacy profile');
  const entries = deliveredEntries();
  assert.ok(entries.length > 0, 'At least one managed parent must be visible to the client');
  const childPath = child.replace(/\\/g, '/').toLowerCase();
  const parent = entries.find(entry => fs.readFileSync(entry.file, 'utf8').replace(/\\/g, '/').toLowerCase().includes(childPath));
  assert.ok(parent, 'Client-visible parent must declare the readable child Skill');
  assert.ok(inside(qaRoot, fs.realpathSync(parent.file)), 'Managed link must resolve inside QA root');
  return { parent: parent.file, child, entries: entries.map(entry => ({ name: entry.name, sha256: hash(entry.file) })) };
}
async function main() {
  const browser = await chromium.connectOverCDP(required('AI_SKILLHUB_CDP_URL'));
  try {
    let page;
    for (let attempt = 0; attempt < 100 && !page; attempt++) {
      page = browser.contexts().flatMap(context => context.pages()).find(candidate => /^https?:\/\/tauri\.localhost/.test(candidate.url()));
      if (!page) await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert.ok(page, 'Native Tauri page must exist');
    page.setDefaultTimeout(240000);
    await page.context().route('https://vibecafe.ai/**', route => route.abort('blockedbyclient'));
    await page.waitForFunction(() => typeof window.__TAURI_INTERNALS__?.invoke === 'function');
    const allowed = ['refresh_agent_detection', 'scan_legacy_snapshot', 'connect_detected_agents', 'load_indexed_snapshot'];
    const invoke = async command => {
      assert.ok(allowed.includes(command));
      for (let attempt = 0; ; attempt++) {
        try { return await page.evaluate(command => window.__TAURI_INTERNALS__.invoke(command), command); }
        catch (error) {
          if (attempt < 120 && /另一项|另一个|正在执行|后台任务正在|稍后重试|正在运行/.test(String(error))) { await page.waitForTimeout(500); continue; }
          throw error;
        }
      }
    };
    let snapshot = await invoke('refresh_agent_detection');
    report.initialDetection = { root: snapshot.root, agents: snapshot.agents, adapters: snapshot.agentAdapters };
    record('refresh-detects-current-native-profile', verifySnapshot(snapshot, false));
    snapshot = await invoke('scan_legacy_snapshot');
    assert.ok(snapshot.skills.some(skill => skill.name === 'qa-child'), 'Fixture child must be indexed');
    record('scan-preserves-installation-detection', verifySnapshot(snapshot, false));
    snapshot = await invoke('connect_detected_agents');
    record('connect-delivers-to-native-profile', verifySnapshot(snapshot, true));
    const first = verifyFiles();
    record('readable-parent-and-preserved-user-files', first);
    const sharedRoot = path.join(profile, '.agents/skills');
    const scannable = fs.readdirSync(sharedRoot, { withFileTypes: true }).filter(entry => entry.isDirectory());
    assert.ok(scannable.length > 0, 'Coze requires real direct child folders');
    for (const entry of scannable.filter(entry => entry.name !== 'personal-shared')) {
      const body = fs.readFileSync(path.join(sharedRoot, entry.name, 'SKILL.md'), 'utf8');
      assert.match(body, /^---\r?\nname: .+\r?\ndescription: .+\r?\n---/);
      assert.ok(body.includes('SKILL.md'), 'Compatible entry must reference the original definition');
    }
    record('coze-compatible-scan-finds-real-directories', scannable.map(entry => entry.name));
    const coze = snapshot.agentAdapters.find(adapter => adapter.id === 'coze');
    assert.equal(coze.detected, true);
    assert.equal(coze.managed, false, 'Filesystem discovery is not cloud Agent registration');
    const defaultScanRoot = path.join(profile, '.agents/skills');
    assert.equal(comparable(coze.skillsPathHint), comparable(defaultScanRoot));
    const defaults = fs.readdirSync(defaultScanRoot, { withFileTypes: true }).filter(entry => entry.isDirectory());
    assert.ok(defaults.some(entry => entry.name === 'personal-shared'));
    for (const delivered of first.entries) {
      assert.ok(defaults.some(entry => entry.name === delivered.name), 'Coze default scanner must see each enabled parent without adding a scan directory');
    }
    assert.equal(fs.readFileSync(path.join(defaultScanRoot, 'personal-shared/SKILL.md'), 'utf8'), '---\nname: personal-shared\ndescription: Preserve shared user Skill.\n---\n# Personal\n');
    assert.ok(!fs.existsSync(path.join(profile, '.codex')), 'Coze installation must not create a fake Codex profile');
    record('coze-default-scan-needs-no-extra-directory', defaults.map(entry => entry.name));
    snapshot = await invoke('load_indexed_snapshot');
    record('sqlite-reload-preserves-managed-state', verifySnapshot(snapshot, true));
    snapshot = await invoke('connect_detected_agents');
    verifySnapshot(snapshot, true);
    const second = verifyFiles();
    assert.deepEqual(second.entries, first.entries, 'Repeated connection must keep the same parent entries and content');
    record('repeat-connect-is-idempotent', second.entries);
    report.result = 'passed';
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  } finally { await browser.close().catch(() => {}); }
}
main().catch(error => {
  report.result = 'failed'; report.error = String(error?.stack || error);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.error(error); process.exit(1);
});

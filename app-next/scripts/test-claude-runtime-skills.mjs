// Optional native acceptance: no user message or model call is sent.
// Usage: node scripts/test-claude-runtime-skills.mjs <official claude.exe>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const binary = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.statSync(binary).isFile()) throw new Error('Provide an installed official Claude Code executable.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillhub-native-claude-'));
const home = path.join(root, 'home');
const shared = path.join(root, 'shared');
const configRoot = path.join(root, 'custom-profile');
const project = path.join(root, 'empty-project');
const parent = path.join(shared, 'research--author');
const child = path.join(root, 'sources', 'drawing');
for (const dir of [home, parent, child, project, configRoot]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(child, 'SKILL.md'), '---\nname: drawing\ndescription: Draw a research figure.\n---\n# Drawing\n');
fs.writeFileSync(path.join(parent, 'SKILL.md'), `---\nname: research--author\ndescription: Research drawing tools.\n---\n<!-- [ROUTER-HUB] -->\n- [CHILD-SKILL] \`drawing\` — Draw a figure; 来源文件：\`${path.join(child, 'SKILL.md').replaceAll('\\', '/')}\`\n`);
const config = path.join(root, 'skillhub.config.json');
fs.writeFileSync(config, JSON.stringify({ version: 3, activeSkillsFolder: shared, githubSourcesFolder: path.join(root, 'sources'), manageAgentLinks: true, repositories: [] }));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(systemroot|windir|comspec|path|pathext|programfiles|programfiles\(x86\)|processor_architecture|number_of_processors)$/i.test(key)));
Object.assign(env, {
  HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  TEMP: root, TMP: root, CLAUDE_CONFIG_DIR: configRoot,
  AI_SKILLHUB_CONFIG_PATH: config, AI_SKILLHUB_AGENT_SKILL_ALLOWLIST: '',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1',
});
let cli;
try {
  const delivery = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../runtime/Manage-AgentSkillLinks.ps1');
  const delivered = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', delivery, '-Quiet', '-HomePath', home, '-SimulateClaudePresent'], { env, cwd: project, encoding: 'utf8', windowsHide: true });
  if (delivered.status !== 0) throw new Error(`Fixture delivery failed: ${delivered.error || delivered.stderr}`);
  const args = ['--settings', '{"disableAllHooks":true}', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence'];
  cli = spawn(binary, args, { env, cwd: project, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const result = await new Promise((resolve, reject) => {
    let buffer = '', errors = '';
    const timeout = setTimeout(() => reject(new Error(`Initialize timed out: ${errors.slice(0, 500)}`)), 25000);
    cli.stderr.on('data', chunk => { errors += chunk; });
    cli.once('error', error => { clearTimeout(timeout); reject(error); });
    cli.once('exit', code => { clearTimeout(timeout); reject(new Error(`Runtime exited ${code}: ${errors.slice(0, 500)}`)); });
    cli.stdout.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.type === 'control_response' && message.response?.request_id === 'skillhub-init') {
          clearTimeout(timeout); resolve(message.response);
        }
      }
    });
    cli.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'skillhub-init', request: { subtype: 'initialize', hooks: {} } }) + '\n');
  });
  const commands = result.response?.commands || [];
  if (!commands.some(command => command.name === 'research--author')) throw new Error(`Delivered parent missing from runtime commands: ${JSON.stringify(commands.map(command => command.name))}`);
  console.log(JSON.stringify({ status: 'PASS', runtime: path.basename(path.dirname(path.dirname(binary))), parent: 'research--author', commandCount: commands.length, isolatedCustomProfile: true, userMessagesSent: 0 }));
} finally {
  if (cli && cli.exitCode === null) { cli.kill(); await new Promise(resolve => cli.once('exit', resolve)); }
  // Remove junctions without traversing their targets, all within our TEMP fixture.
  for (const dir of [path.join(configRoot, 'skills'), path.join(home, '.agents', 'skills'), path.join(home, '.codex', 'skills')]) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const candidate = path.join(dir, entry);
      if (fs.lstatSync(candidate).isSymbolicLink()) fs.unlinkSync(candidate);
    }
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace AISkillHubWeb
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            ConfigureRuntime();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            if (args.Length > 0 && args[0] == "--self-test")
            {
                Diagnostics.Run();
                return;
            }

            if (args.Length > 0 && args[0] == "--zip-preview-test")
            {
                Diagnostics.RunZipPreviewTest();
                return;
            }

            if (args.Length > 0 && args[0] == "--troubleshooting-test")
            {
                Diagnostics.RunTroubleshootingTest();
                return;
            }

            if (args.Length > 0 && args[0] == "--share-recipient-test")
            {
                Diagnostics.RunShareRecipientTest();
                return;
            }

            if (args.Length > 0 && args[0] == "--release-preflight")
            {
                Diagnostics.RunReleasePreflight();
                return;
            }

            Application.Run(new SkillHubWindow());
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetDllDirectory(string lpPathName);

        private static void ConfigureRuntime()
        {
            string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            string runtime = Path.Combine(root, "app", "runtime");
            if (Directory.Exists(runtime)) SetDllDirectory(runtime);
            AppDomain.CurrentDomain.AssemblyResolve += delegate(object sender, ResolveEventArgs e)
            {
                string name = new System.Reflection.AssemblyName(e.Name).Name + ".dll";
                string candidate = Path.Combine(runtime, name);
                return File.Exists(candidate) ? System.Reflection.Assembly.LoadFrom(candidate) : null;
            };
        }
    }

    internal static class Diagnostics
    {
        public static void Run()
        {
            string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            string app = Path.Combine(root, "app");
            string report = Path.Combine(app, "reports", "webview-self-test.txt");
            Directory.CreateDirectory(Path.GetDirectoryName(report));

            try
            {
                Require(Path.Combine(app, "ui", "index.html"));
                Require(Path.Combine(app, "ui", "styles.css"));
                Require(Path.Combine(app, "ui", "app.js"));
                Require(Path.Combine(app, "skillhub.config.example.json"));
                Require(Path.Combine(app, "SkillHub.ps1"));
                Require(Path.Combine(app, "Export-SkillHubDiagnostics.ps1"));
                Require(Path.Combine(app, "Test-ShareRecipientExperience.ps1"));
                Require(Path.Combine(app, "Build-SkillHubReleasePackage.ps1"));
                Require(Path.Combine(app, "runtime", "Microsoft.Web.WebView2.Core.dll"));
                Require(Path.Combine(app, "runtime", "Microsoft.Web.WebView2.WinForms.dll"));
                Require(Path.Combine(app, "runtime", "WebView2Loader.dll"));

                using (var form = new SkillHubWindow(true))
                {
                    form.WindowState = FormWindowState.Maximized;
                    form.PerformLayout();
                    form.WindowState = FormWindowState.Normal;
                    form.PerformLayout();
                }

                File.WriteAllText(report, "OK " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"), Encoding.UTF8);
            }
            catch (Exception ex)
            {
                File.WriteAllText(report, "FAILED " + ex, Encoding.UTF8);
                Environment.ExitCode = 1;
            }
        }

        private static void Require(string path)
        {
            if (!File.Exists(path)) throw new FileNotFoundException("Missing required file", path);
        }

        public static void RunShareRecipientTest()
        {
            string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            string app = Path.Combine(root, "app");
            string reportDir = Path.Combine(app, "reports", "share-recipient-test");
            string script = Path.Combine(app, "Test-ShareRecipientExperience.ps1");
            Directory.CreateDirectory(reportDir);
            string hostLog = Path.Combine(reportDir, "latest-share-recipient-host.txt");

            try
            {
                Require(script);
                string output = RunProcess(PowerShellPath(), "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\" -Quiet", app);
                File.WriteAllText(hostLog, output, new UTF8Encoding(false));
            }
            catch (Exception ex)
            {
                File.WriteAllText(hostLog, "FAILED " + ex.Message, new UTF8Encoding(false));
                Environment.ExitCode = 1;
            }
        }

        public static void RunReleasePreflight()
        {
            string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            string app = Path.Combine(root, "app");
            string reportDir = Path.Combine(app, "reports", "release-preflight");
            string script = Path.Combine(app, "Build-SkillHubReleasePackage.ps1");
            Directory.CreateDirectory(reportDir);
            string hostLog = Path.Combine(reportDir, "latest-release-preflight-host.txt");

            try
            {
                Require(script);
                string output = RunProcess(PowerShellPath(), "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\" -Quiet", app);
                File.WriteAllText(hostLog, output, new UTF8Encoding(false));
            }
            catch (Exception ex)
            {
                File.WriteAllText(hostLog, "FAILED " + ex.Message, new UTF8Encoding(false));
                Environment.ExitCode = 1;
            }
        }

        private static string PowerShellPath()
        {
            string path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
            if (!File.Exists(path)) throw new FileNotFoundException("Missing Windows PowerShell", path);
            return path;
        }

        private static string RunProcess(string fileName, string arguments, string workingDirectory)
        {
            var psi = new ProcessStartInfo();
            psi.FileName = fileName;
            psi.Arguments = arguments;
            psi.WorkingDirectory = workingDirectory;
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.CreateNoWindow = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            using (var p = Process.Start(psi))
            {
                string stdout = p.StandardOutput.ReadToEnd();
                string stderr = p.StandardError.ReadToEnd();
                p.WaitForExit();
                if (p.ExitCode != 0) throw new InvalidOperationException((stderr.Length > 0 ? stderr : stdout).Trim());
                return stdout + (stderr.Length > 0 ? Environment.NewLine + stderr : "");
            }
        }

        public static void RunZipPreviewTest()
        {
            string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            string app = Path.Combine(root, "app");
            string reportDir = Path.Combine(app, "reports", "zip-preview-test");
            Directory.CreateDirectory(reportDir);

            string runId = DateTime.Now.ToString("yyyyMMdd_HHmmss_fff");
            string workDir = Path.Combine(reportDir, runId);
            string jsonReport = Path.Combine(reportDir, "latest-zip-preview-test.json");
            string mdReport = Path.Combine(reportDir, "latest-zip-preview-test.md");

            try
            {
                Directory.CreateDirectory(workDir);
                string sampleRoot = Path.Combine(workDir, "sample-root");
                string sampleSkill = Path.Combine(sampleRoot, "sample-skill");
                Directory.CreateDirectory(sampleSkill);
                File.WriteAllText(Path.Combine(sampleSkill, "SKILL.md"), "# sample-skill" + Environment.NewLine + Environment.NewLine + "A zip preview smoke-test skill.", new UTF8Encoding(false));
                File.WriteAllText(Path.Combine(sampleRoot, "README.md"), "# Sample Skill Pack", new UTF8Encoding(false));

                string zipPath = Path.Combine(workDir, "sample-skill-pack-main.zip");
                ZipFile.CreateFromDirectory(sampleRoot, zipPath, CompressionLevel.Optimal, false);

                string traversalZipPath = Path.Combine(workDir, "unsafe-zip-slip.zip");
                using (var archive = ZipFile.Open(traversalZipPath, ZipArchiveMode.Create))
                {
                    var entry = archive.CreateEntry("../evil.txt");
                    using (var writer = new StreamWriter(entry.Open(), new UTF8Encoding(false)))
                    {
                        writer.Write("blocked");
                    }
                }

                Dictionary<string, object> result;
                using (var form = new SkillHubWindow(true))
                {
                    result = form.RunZipPreviewSmokeTest(zipPath, Path.Combine(workDir, "extracted"), traversalZipPath);
                }

                bool ok = Convert.ToBoolean(result["ok"]);
                var payload = new Dictionary<string, object>();
                payload["ok"] = ok;
                payload["generatedAt"] = DateTime.Now.ToString("o");
                payload["runId"] = runId;
                payload["zipPath"] = zipPath;
                payload["workDir"] = workDir;
                payload["result"] = result;

                var serializer = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 * 10 };
                File.WriteAllText(jsonReport, serializer.Serialize(payload), Encoding.UTF8);
                File.WriteAllText(mdReport, BuildZipPreviewTestMarkdown(payload, result), Encoding.UTF8);

                if (!ok) Environment.ExitCode = 1;
            }
            catch (Exception ex)
            {
                var payload = new Dictionary<string, object>();
                payload["ok"] = false;
                payload["generatedAt"] = DateTime.Now.ToString("o");
                payload["runId"] = runId;
                payload["workDir"] = workDir;
                payload["error"] = ex.Message;

                var serializer = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 * 10 };
                File.WriteAllText(jsonReport, serializer.Serialize(payload), Encoding.UTF8);
                File.WriteAllText(mdReport, "# Zip 导入预览自动测试" + Environment.NewLine + Environment.NewLine + "状态：失败" + Environment.NewLine + Environment.NewLine + ex.Message, Encoding.UTF8);
                Environment.ExitCode = 1;
            }
        }

        private static string BuildZipPreviewTestMarkdown(Dictionary<string, object> payload, Dictionary<string, object> result)
        {
            var sb = new StringBuilder();
            sb.AppendLine("# Zip 导入预览自动测试");
            sb.AppendLine();
            sb.AppendLine("- 状态：" + (Convert.ToBoolean(payload["ok"]) ? "通过" : "失败"));
            sb.AppendLine("- 时间：" + Convert.ToString(payload["generatedAt"]));
            sb.AppendLine("- 测试目录：" + Convert.ToString(payload["workDir"]));
            sb.AppendLine("- 预览识别到的 Skill 数量：" + Convert.ToString(result["previewSkillCount"]));
            sb.AppendLine("- 示例 Skill：" + Convert.ToString(result["sampleSkills"]));
            sb.AppendLine("- zip 安全解压：" + (Convert.ToBoolean(result["safeExtracted"]) ? "通过" : "失败"));
            sb.AppendLine("- zip slip 拦截：" + (Convert.ToBoolean(result["traversalBlocked"]) ? "通过" : "失败"));
            sb.AppendLine();
            sb.AppendLine("说明：该测试只使用临时 zip，不会写入正式 `skills` 或 `app\\github_sources`。");
            return sb.ToString();
        }

        public static void RunTroubleshootingTest()
        {
            string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            string app = Path.Combine(root, "app");
            string reportDir = Path.Combine(app, "reports", "troubleshooting");
            Directory.CreateDirectory(reportDir);

            string jsonReport = Path.Combine(reportDir, "latest-troubleshooting-test.json");
            string mdReport = Path.Combine(reportDir, "latest-troubleshooting-test.md");
            var serializer = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 * 10 };
            var payload = new Dictionary<string, object>();

            try
            {
                string zipPath;
                using (var form = new SkillHubWindow(true))
                {
                    zipPath = form.RunTroubleshootingBundleSmokeTest();
                }

                payload["ok"] = File.Exists(zipPath);
                payload["generatedAt"] = DateTime.Now.ToString("o");
                payload["zipPath"] = zipPath;
                payload["length"] = File.Exists(zipPath) ? new FileInfo(zipPath).Length : 0;

                File.WriteAllText(jsonReport, serializer.Serialize(payload), new UTF8Encoding(false));
                File.WriteAllText(mdReport, BuildTroubleshootingTestMarkdown(payload), new UTF8Encoding(false));
                if (!Convert.ToBoolean(payload["ok"])) Environment.ExitCode = 1;
            }
            catch (Exception ex)
            {
                payload["ok"] = false;
                payload["generatedAt"] = DateTime.Now.ToString("o");
                payload["error"] = ex.Message;
                File.WriteAllText(jsonReport, serializer.Serialize(payload), new UTF8Encoding(false));
                File.WriteAllText(mdReport, "# 排错包自动测试" + Environment.NewLine + Environment.NewLine + "状态：失败" + Environment.NewLine + Environment.NewLine + ex.Message, new UTF8Encoding(false));
                Environment.ExitCode = 1;
            }
        }

        private static string BuildTroubleshootingTestMarkdown(Dictionary<string, object> payload)
        {
            var sb = new StringBuilder();
            sb.AppendLine("# 排错包自动测试");
            sb.AppendLine();
            sb.AppendLine("- 状态：" + (Convert.ToBoolean(payload["ok"]) ? "通过" : "失败"));
            sb.AppendLine("- 时间：" + Convert.ToString(payload["generatedAt"]));
            sb.AppendLine("- 输出：" + Convert.ToString(payload["zipPath"]));
            sb.AppendLine("- 大小：" + Convert.ToString(payload["length"]) + " bytes");
            sb.AppendLine();
            sb.AppendLine("说明：该测试只打包 `app\\reports` 中的脱敏报告，不会包含 `skills` 或 `app\\github_sources` 的实际内容。");
            return sb.ToString();
        }
    }

    public sealed class SkillHubWindow : Form
    {
        private const string AppVersion = "1.1.1";
        private const int WM_NCHITTEST = 0x84;
        private const int WM_NCLBUTTONDOWN = 0xA1;
        private const int HTCLIENT = 1;
        private const int HTCAPTION = 2;
        private const int HTLEFT = 10;
        private const int HTRIGHT = 11;
        private const int HTTOP = 12;
        private const int HTTOPLEFT = 13;
        private const int HTTOPRIGHT = 14;
        private const int HTBOTTOM = 15;
        private const int HTBOTTOMLEFT = 16;
        private const int HTBOTTOMRIGHT = 17;

        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 * 50 };
        private readonly string root;
        private readonly string appRoot;
        private readonly string skillsRoot;
        private readonly string configPath;
        private readonly string sourceRoot;
        private readonly string reportsRoot;
        private readonly string skillHubScript;
        private readonly string linksScript;
        private readonly string diagnosticsScript;
        private readonly string installTaskScript;
        private readonly string uninstallTaskScript;
        private readonly bool diagnosticMode;
        private WebView2 web;
        private SkillHubConfig config;

        public SkillHubWindow() : this(false) { }

        public SkillHubWindow(bool diagnosticMode)
        {
            this.diagnosticMode = diagnosticMode;
            root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            appRoot = Path.Combine(root, "app");
            skillsRoot = Path.Combine(root, "skills");
            configPath = Path.Combine(appRoot, "skillhub.config.json");
            sourceRoot = Path.Combine(appRoot, "github_sources");
            reportsRoot = Path.Combine(appRoot, "reports");
            skillHubScript = Path.Combine(appRoot, "SkillHub.ps1");
            linksScript = Path.Combine(appRoot, "Manage-AgentSkillLinks.ps1");
            diagnosticsScript = Path.Combine(appRoot, "Export-SkillHubDiagnostics.ps1");
            installTaskScript = Path.Combine(appRoot, "安装每日自动更新任务.ps1");
            uninstallTaskScript = Path.Combine(appRoot, "卸载每日自动更新任务.ps1");

            Text = "AI SkillHub";
            MinimumSize = new Size(920, 620);
            var area = Screen.PrimaryScreen.WorkingArea;
            int width = Math.Min(1180, Math.Max(1020, area.Width - 280));
            int height = Math.Min(760, Math.Max(660, area.Height - 220));
            Size = new Size(Math.Min(width, area.Width), Math.Min(height, area.Height));
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.None;
            BackColor = Color.FromArgb(244, 250, 247);
            Icon = LoadIcon();

            web = new WebView2();
            web.Dock = DockStyle.Fill;
            Controls.Add(web);

            if (!diagnosticMode)
                Load += async delegate { await InitializeWebView(); };
        }

        private Icon LoadIcon()
        {
            string icon = Path.Combine(appRoot, "assets", "AI SkillHub.ico");
            return File.Exists(icon) ? new Icon(icon) : SystemIcons.Application;
        }

        private async Task InitializeWebView()
        {
            Directory.CreateDirectory(Path.Combine(appRoot, "webview2-data"));
            Directory.CreateDirectory(reportsRoot);
            EnsureConfigExists();
            EnsurePortableState();

            var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(appRoot, "webview2-data"));
            await web.EnsureCoreWebView2Async(env);
            web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            web.CoreWebView2.Settings.IsStatusBarEnabled = false;
            web.CoreWebView2.Settings.AreDevToolsEnabled = true;
            web.CoreWebView2.WebMessageReceived += OnWebMessageReceived;

            string ui = Path.Combine(appRoot, "ui", "index.html");
            web.Source = new Uri(ui);
        }

        private void OnWebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            Dictionary<string, object> message = null;
            try
            {
                message = json.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson);
                string action = GetString(message, "action");
                if (action == "ready" || action == "refresh") SendState();
                else if (action == "sync") RunSyncAsync(true);
                else if (action == "addRepo") AddRepository(message);
                else if (action == "saveRepo") SaveRepository(message);
                else if (action == "deleteRepo") DeleteRepository(message);
                else if (action == "setRepoEnabled") SetRepositoryEnabled(message);
                else if (action == "chooseLocalSource") ChooseLocalSource();
                else if (action == "chooseZipSource") ChooseZipSource();
                else if (action == "importLocalSource") ImportLocalSource(message);
                else if (action == "setDailyUpdate") SetDailyUpdate(GetBool(message, "enabled"));
                else if (action == "setManageLinks") SetManageLinks(GetBool(message, "enabled"));
                else if (action == "openReport") OpenPath(Path.Combine(reportsRoot, "last-sync.md"));
                else if (action == "exportDiagnostics" || action == "runHealthCheck") ExportDiagnostics();
                else if (action == "exportTroubleshooting") ExportTroubleshootingBundle();
                else if (action == "shareCheck") RunShareCheck();
                else if (action == "openSkills") OpenPath(skillsRoot);
                else if (action == "openSources") OpenPath(sourceRoot);
                else if (action == "openReports") OpenPath(reportsRoot);
                else if (action == "openSourcePath") OpenSourcePath(message);
                else if (action == "openRoot") OpenPath(root);
                else if (action == "window.minimize") WindowState = FormWindowState.Minimized;
                else if (action == "window.maximize") WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
                else if (action == "window.close") Close();
                else if (action == "window.drag") BeginDragMove();
                else if (action == "window.resize") BeginResize(GetString(message, "edge"));
            }
            catch (Exception ex)
            {
                Toast("error", "操作失败：" + ex.Message);
                Log("error", ex.Message);
            }
        }

        private void SendState()
        {
            try
            {
                LoadConfig();
                var state = new Dictionary<string, object>();
                var repos = LoadRepositories();
                var skills = LoadSkills();

                state["root"] = root;
                state["appRoot"] = appRoot;
                state["skillsRoot"] = skillsRoot;
                state["sourcesRoot"] = sourceRoot;
                state["repositories"] = repos;
                state["skills"] = skills;
                state["manageAgentLinks"] = config.manageAgentLinks;
                state["autoDiscoverManualRepos"] = config.autoDiscoverManualRepos;
                state["dailyUpdateEnabled"] = IsDailyTaskEnabled();
                state["lastSync"] = GetLastSync();
                state["repoCount"] = repos.Count;
                state["skillCount"] = skills.Count;
                state["promptCount"] = repos.Count(delegate(RepoView r) { return r.type == "prompt"; });
                state["linkStatus"] = LoadLinkStatus(skills.Count);
                state["diagnostics"] = LoadDiagnosticsOverview();
                state["operationHistory"] = LoadOperationHistory();
                state["logo"] = Path.Combine(appRoot, "assets", "AI SkillHub.logo.ui.png");
                state["version"] = "v" + AppVersion;

                Post(new Dictionary<string, object> { { "type", "state" }, { "data", state } });
            }
            catch (Exception ex)
            {
                Toast("error", "读取状态失败：" + ex.Message);
            }
        }

        private SkillHubConfig BuildDefaultConfig()
        {
            return new SkillHubConfig
            {
                version = 2,
                githubSourcesFolder = "github_sources",
                activeSkillsFolder = "..\\skills",
                manageAgentLinks = false,
                autoDiscoverManualRepos = true,
                preferredPathFragments = new List<string>
                {
                    "\\.claude\\skills\\",
                    "\\skills\\",
                    "\\.agents\\skills\\"
                },
                repositories = new List<RepoConfig>()
            };
        }

        private void EnsureConfigExists()
        {
            if (File.Exists(configPath)) return;
            Directory.CreateDirectory(appRoot);
            config = BuildDefaultConfig();
            SaveConfig();
        }

        private void LoadConfig()
        {
            EnsureConfigExists();
            config = json.Deserialize<SkillHubConfig>(File.ReadAllText(configPath, Encoding.UTF8));
            if (config == null) config = BuildDefaultConfig();
            if (config.repositories == null) config.repositories = new List<RepoConfig>();
            if (config.preferredPathFragments == null) config.preferredPathFragments = new List<string>();
            foreach (var repo in config.repositories)
            {
                if (repo.tags == null) repo.tags = new List<string>();
                repo.tags = NormalizeTags(repo.tags);
            }
        }

        private void EnsurePortableState()
        {
            string stateDir = Path.Combine(appRoot, ".skillhub");
            string marker = Path.Combine(stateDir, "portable-root.txt");
            string managed = Path.Combine(stateDir, "managed-links.json");
            Directory.CreateDirectory(stateDir);
            Directory.CreateDirectory(reportsRoot);

            bool rootChanged = !File.Exists(marker) || !String.Equals(File.ReadAllText(marker, Encoding.UTF8), root, StringComparison.OrdinalIgnoreCase);
            bool missingManagedState = !File.Exists(managed);
            if (!rootChanged && !missingManagedState) return;

            try
            {
                RunProcess(PowerShellPath(), "-NoProfile -ExecutionPolicy Bypass -File \"" + skillHubScript + "\" -NoPull");
                File.WriteAllText(marker, root, new UTF8Encoding(false));
            }
            catch (Exception ex)
            {
                File.WriteAllText(Path.Combine(reportsRoot, "portable-repair-error.txt"), ex.ToString(), Encoding.UTF8);
            }
        }

        private void SaveConfig()
        {
            string text = json.Serialize(config);
            text = PrettyJson(text);
            File.WriteAllText(configPath, text, new UTF8Encoding(true));
        }

        private string PrettyJson(string compact)
        {
            int indent = 0;
            bool quoted = false;
            var sb = new StringBuilder();
            for (int i = 0; i < compact.Length; i++)
            {
                char ch = compact[i];
                if (ch == '"' && (i == 0 || compact[i - 1] != '\\')) quoted = !quoted;
                if (!quoted && (ch == '{' || ch == '['))
                {
                    sb.Append(ch).AppendLine();
                    indent++;
                    sb.Append(new string(' ', indent * 2));
                }
                else if (!quoted && (ch == '}' || ch == ']'))
                {
                    sb.AppendLine();
                    indent--;
                    sb.Append(new string(' ', indent * 2)).Append(ch);
                }
                else if (!quoted && ch == ',')
                {
                    sb.Append(ch).AppendLine();
                    sb.Append(new string(' ', indent * 2));
                }
                else if (!quoted && ch == ':')
                {
                    sb.Append(": ");
                }
                else
                {
                    sb.Append(ch);
                }
            }
            return sb.ToString();
        }

        private List<RepoView> LoadRepositories()
        {
            Directory.CreateDirectory(sourceRoot);
            var byName = new Dictionary<string, RepoView>(StringComparer.OrdinalIgnoreCase);

            foreach (var repo in config.repositories)
            {
                string name = repo.name ?? GetRepoNameFromUrl(repo.url);
                var row = new RepoView();
                row.name = name;
                row.url = NormalizeGithubUrl(repo.url ?? "");
                row.type = repo.type == "prompt" ? "prompt" : "skills";
                row.mode = repo.mode ?? (row.type == "prompt" ? "do-not-install" : "scan");
                row.categoryId = repo.categoryId ?? "";
                row.note = repo.note ?? "";
                row.tags = NormalizeTags(repo.tags);
                row.path = Path.Combine(sourceRoot, name);
                row.exists = Directory.Exists(row.path);
                row.commit = GetGitCommit(row.path);
                row.isGitRepo = Directory.Exists(Path.Combine(row.path, ".git"));
                row.sourceKind = row.url.Length > 0 ? "github" : "local";
                row.skillCount = CountSkillFiles(row.path);
                row.enabled = row.type == "skills" && row.mode != "do-not-install";
                row.configured = true;
                byName[name] = row;
            }

            foreach (var dir in Directory.GetDirectories(sourceRoot))
            {
                string name = Path.GetFileName(dir);
                if (byName.ContainsKey(name)) continue;
                var row = new RepoView();
                row.name = name;
                row.url = "";
                row.type = "skills";
                row.mode = "manual";
                row.categoryId = "";
                row.note = "Manual source folder";
                row.tags = new List<string>();
                row.path = dir;
                row.exists = true;
                row.commit = GetGitCommit(dir);
                row.isGitRepo = Directory.Exists(Path.Combine(dir, ".git"));
                row.sourceKind = row.isGitRepo ? "github-local" : "manual";
                row.skillCount = CountSkillFiles(dir);
                row.enabled = true;
                row.configured = false;
                byName[name] = row;
            }

            return byName.Values.OrderBy(r => r.name, StringComparer.OrdinalIgnoreCase).ToList();
        }

        private List<SkillView> LoadSkills()
        {
            var result = new Dictionary<string, SkillView>(StringComparer.OrdinalIgnoreCase);
            var repoTags = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
            foreach (var repo in config.repositories)
            {
                string repoName = repo.name ?? GetRepoNameFromUrl(repo.url);
                if (repoName.Length > 0 && !repoTags.ContainsKey(repoName))
                    repoTags[repoName] = NormalizeTags(repo.tags);
            }

            string managed = Path.Combine(appRoot, ".skillhub", "managed-links.json");
            if (File.Exists(managed))
            {
                var rows = json.Deserialize<List<ManagedSkill>>(File.ReadAllText(managed, Encoding.UTF8));
                if (rows != null)
                {
                    foreach (var row in rows)
                    {
                        var skill = new SkillView();
                        skill.name = row.Skill ?? "";
                        skill.repo = row.Repo ?? "";
                        skill.categoryId = row.CategoryId ?? "general";
                        skill.note = row.Note ?? "";
                        skill.description = CleanDescription(row.Description);
                        skill.target = row.Target ?? "";
                        skill.mode = "managed";
                        skill.localPath = Path.Combine(skillsRoot, skill.name);
                        skill.tags = repoTags.ContainsKey(skill.repo) ? repoTags[skill.repo] : new List<string>();
                        if (skill.name.Length > 0) result[skill.name] = skill;
                    }
                }
            }

            if (Directory.Exists(skillsRoot))
            {
                foreach (var dir in Directory.GetDirectories(skillsRoot))
                {
                    string name = Path.GetFileName(dir);
                    if (name.StartsWith(".")) continue;
                    if (result.ContainsKey(name)) continue;
                    string skillMd = Path.Combine(dir, "SKILL.md");
                    if (!File.Exists(skillMd)) continue;
                    SkillMeta meta = ReadSkillMeta(skillMd);
                    var skill = new SkillView();
                    skill.name = meta.name.Length > 0 ? meta.name : name;
                    skill.repo = "local";
                    skill.categoryId = InferCategory(skill.name, meta.description, "local");
                    skill.note = "Local skill folder";
                    skill.description = CleanDescription(meta.description);
                    skill.target = dir;
                    skill.localPath = dir;
                    skill.mode = "local";
                    skill.tags = new List<string>();
                    result[skill.name] = skill;
                }
            }

            return result.Values.OrderBy(s => s.name, StringComparer.OrdinalIgnoreCase).ToList();
        }

        private SkillMeta ReadSkillMeta(string skillMd)
        {
            var meta = new SkillMeta();
            foreach (string raw in File.ReadLines(skillMd, Encoding.UTF8).Take(120))
            {
                string line = raw.Trim();
                if (line.StartsWith("name:"))
                    meta.name = line.Substring(5).Trim().Trim('"').Trim('\'');
                if (line.StartsWith("description:"))
                    meta.description = line.Substring(12).Trim().Trim('"').Trim('\'');
            }
            return meta;
        }

        private string CleanDescription(string value)
        {
            if (String.IsNullOrWhiteSpace(value) || value.Trim() == ">-" || value.Trim() == "|") return "";
            return value.Trim();
        }

        private string InferCategory(string name, string description, string repo)
        {
            string text = ((name ?? "") + " " + (description ?? "") + " " + (repo ?? "")).ToLowerInvariant();
            if (Regex.IsMatch(text, "vibesec|security|secure|vulnerability|xss|csrf|audit")) return "security";
            if (Regex.IsMatch(text, "agent-browser|browser automation|agent|workflow|best-practice|claude-code")) return "agent-tools";
            if (Regex.IsMatch(text, "gpt-image|image generation|image edit|raster|poster|avatar")) return "image-generation";
            if (Regex.IsMatch(text, "kb-retriever|knowledge|retrieval|local knowledge|检索")) return "knowledge-retrieval";
            if (Regex.IsMatch(text, "presentation|ppt|slide|deck|paper2ppt|video-presentation")) return "presentation";
            if (Regex.IsMatch(text, "frontend|ui|interface|design|layout|component|web-design|impeccable")) return "ui-design";
            if (Regex.IsMatch(text, "figure|plot|chart|panel|legend|matplotlib|ggplot|visualization")) return "scientific-figures";
            if (Regex.IsMatch(text, "literature|academic-researcher|paper-analyzer|results-analysis|methodolog|research gap")) return "literature-research";
            if (Regex.IsMatch(text, "nature|manuscript|scientific-writing|paper|rebuttal|submission|citation|reference|conference|reviewer|academic")) return "academic-writing";
            if (Regex.IsMatch(text, "prompt|polish|editing|proofread|writing")) return "prompt-polishing";
            return "general";
        }

        private void AddRepository(Dictionary<string, object> message)
        {
            LoadConfig();
            string url = NormalizeGithubUrl(GetString(message, "url"));
            string repoType = GetString(message, "repoType") == "prompt" ? "prompt" : "skills";
            string categoryId = GetString(message, "categoryId");
            string note = GetString(message, "note");
            List<string> tags = GetTags(message, "tags");

            if (!IsSafeGithubUrl(url)) throw new InvalidOperationException("GitHub 地址格式不正确，请使用：https://github.com/作者/仓库.git");
            string name = GetRepoNameFromUrl(url);
            if (!IsSafeRepoName(name)) throw new InvalidOperationException("仓库名称包含不安全字符。");

            RepoConfig repo = config.repositories.FirstOrDefault(r => String.Equals(r.name, name, StringComparison.OrdinalIgnoreCase));
            if (repo == null)
            {
                repo = new RepoConfig();
                config.repositories.Add(repo);
            }

            repo.name = name;
            repo.url = url;
            repo.type = repoType;
            repo.mode = repoType == "prompt" ? "do-not-install" : "scan";
            repo.categoryId = categoryId == "auto" ? null : categoryId;
            repo.note = note ?? "";
            repo.tags = tags;
            SaveConfig();
            AppendOperationHistory("source.add", "添加来源", name + " · " + (repoType == "prompt" ? "Prompt" : "Skill"), "success");
            Toast("success", "已添加仓库：" + name);
            RunSyncAsync(true);
        }

        private void SaveRepository(Dictionary<string, object> message)
        {
            LoadConfig();
            string name = GetString(message, "name");
            RepoConfig repo = config.repositories.FirstOrDefault(r => String.Equals(r.name, name, StringComparison.OrdinalIgnoreCase));
            if (repo == null) throw new InvalidOperationException("没有找到这个仓库来源。");

            string url = NormalizeGithubUrl(GetString(message, "url"));
            if (url.Length > 0 && !IsSafeGithubUrl(url)) throw new InvalidOperationException("GitHub 地址格式不正确，请使用：https://github.com/作者/仓库.git");
            if (url.Length > 0) repo.url = url;

            string repoType = GetString(message, "repoType") == "prompt" ? "prompt" : "skills";
            repo.type = repoType;
            repo.mode = repoType == "prompt" ? "do-not-install" : (String.IsNullOrWhiteSpace(repo.mode) || repo.mode == "do-not-install" ? "scan" : repo.mode);
            string categoryId = GetString(message, "categoryId");
            repo.categoryId = categoryId == "auto" ? null : categoryId;
            repo.note = GetString(message, "note") ?? "";
            repo.tags = GetTags(message, "tags");
            SaveConfig();
            AppendOperationHistory("source.save", "保存来源", name, "success");
            Toast("success", "已保存：" + name);
            RunSyncAsync(false);
        }

        private void DeleteRepository(Dictionary<string, object> message)
        {
            LoadConfig();
            string name = GetString(message, "name");
            if (!IsSafeRepoName(name)) throw new InvalidOperationException("仓库名称不安全。");
            RepoConfig repo = config.repositories.FirstOrDefault(r => String.Equals(r.name, name, StringComparison.OrdinalIgnoreCase));
            if (repo != null) config.repositories.Remove(repo);
            SaveConfig();
            AppendOperationHistory("source.delete", "删除来源", name, "success");
            Toast("success", "已从配置移除：" + name);
            RunSyncAsync(false);
        }

        private void SetRepositoryEnabled(Dictionary<string, object> message)
        {
            LoadConfig();
            string name = GetString(message, "name");
            if (!IsSafeRepoName(name)) throw new InvalidOperationException("仓库名称不安全。");
            RepoConfig repo = config.repositories.FirstOrDefault(r => String.Equals(r.name, name, StringComparison.OrdinalIgnoreCase));
            if (repo == null) throw new InvalidOperationException("这个来源是自动发现的本地文件夹，暂时不能在这里切换启用状态。");
            if (repo.type == "prompt") throw new InvalidOperationException("Prompt 来源只保存资料，不安装为 Skill。");

            bool enabled = GetBool(message, "enabled");
            repo.mode = enabled ? "scan" : "do-not-install";
            SaveConfig();
            AppendOperationHistory("source.toggle", enabled ? "启用来源" : "停用来源", name, "success");
            Toast("success", enabled ? ("已启用来源：" + name) : ("已停用来源：" + name));
            RunSyncAsync(false);
        }

        private void ChooseLocalSource()
        {
            using (var dialog = new FolderBrowserDialog())
            {
                dialog.Description = "选择包含 SKILL.md 的本地文件夹，或选择 GitHub zip 解压后的项目根目录";
                dialog.ShowNewFolderButton = false;
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                SendImportPreview(BuildFolderPreview(dialog.SelectedPath));
            }
        }

        private void ChooseZipSource()
        {
            using (var dialog = new OpenFileDialog())
            {
                dialog.Title = "选择 GitHub 下载的 zip 压缩包";
                dialog.Filter = "Zip files (*.zip)|*.zip";
                dialog.CheckFileExists = true;
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                SendImportPreview(BuildZipPreview(dialog.FileName));
            }
        }

        private void SendImportPreview(ImportPreview preview)
        {
            Post(new Dictionary<string, object> { { "type", "importPreview" }, { "data", preview } });
            Log("info", "导入预览：" + preview.recommendedName + "，发现 " + preview.skillCount + " 个 Skill。");
        }

        private ImportPreview BuildFolderPreview(string folder)
        {
            string full = Path.GetFullPath(folder);
            if (!Directory.Exists(full)) throw new DirectoryNotFoundException(full);
            var preview = NewImportPreview(full, "folder", Path.GetFileName(full.TrimEnd('\\')));

            foreach (string file in EnumerateSafeFiles(full).Take(2000))
            {
                preview.fileCount++;
                string name = Path.GetFileName(file);
                string relative = RelativePath(full, file);
                if (String.Equals(name, "SKILL.md", StringComparison.OrdinalIgnoreCase))
                {
                    preview.skillCount++;
                    if (String.Equals(Path.GetDirectoryName(file).TrimEnd('\\'), full.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                        preview.hasSkillMdAtRoot = true;
                    string skillFolder = Path.GetFileName(Path.GetDirectoryName(file));
                    if (preview.sampleSkills.Count < 8) preview.sampleSkills.Add(skillFolder);
                }
                if (String.Equals(name, "README.md", StringComparison.OrdinalIgnoreCase)) preview.hasReadme = true;
                if (LooksLikePromptOrReference(relative)) preview.promptHintCount++;
            }

            preview.canImport = Directory.Exists(full) && (preview.skillCount > 0 || preview.promptHintCount > 0 || preview.hasReadme);
            preview.message = preview.skillCount > 0 ? "可以导入。同步后会只启用包含 SKILL.md 的目录。" : "没有发现 SKILL.md，建议作为 Prompt/资料来源保存。";
            return preview;
        }

        private ImportPreview BuildZipPreview(string zipPath)
        {
            string full = Path.GetFullPath(zipPath);
            if (!File.Exists(full)) throw new FileNotFoundException("zip 文件不存在", full);
            string name = Path.GetFileNameWithoutExtension(full);
            if (name.EndsWith("-main", StringComparison.OrdinalIgnoreCase)) name = name.Substring(0, name.Length - 5);
            if (name.EndsWith("-master", StringComparison.OrdinalIgnoreCase)) name = name.Substring(0, name.Length - 7);
            var preview = NewImportPreview(full, "zip", name);

            using (var archive = ZipFile.OpenRead(full))
            {
                foreach (var entry in archive.Entries.Take(3000))
                {
                    if (entry.FullName.EndsWith("/", StringComparison.Ordinal)) continue;
                    preview.fileCount++;
                    string entryName = Path.GetFileName(entry.FullName.Replace('/', '\\'));
                    if (String.Equals(entryName, "SKILL.md", StringComparison.OrdinalIgnoreCase))
                    {
                        preview.skillCount++;
                        if (!entry.FullName.Contains("/")) preview.hasSkillMdAtRoot = true;
                        string folder = Path.GetFileName(Path.GetDirectoryName(entry.FullName.Replace('/', '\\')) ?? "");
                        if (preview.sampleSkills.Count < 8) preview.sampleSkills.Add(folder);
                    }
                    if (String.Equals(entryName, "README.md", StringComparison.OrdinalIgnoreCase)) preview.hasReadme = true;
                    if (LooksLikePromptOrReference(entry.FullName)) preview.promptHintCount++;
                }
            }

            preview.canImport = preview.skillCount > 0 || preview.promptHintCount > 0 || preview.hasReadme;
            preview.message = preview.skillCount > 0 ? "可以导入。同步后会只启用包含 SKILL.md 的目录。" : "没有发现 SKILL.md，建议作为 Prompt/资料来源保存。";
            return preview;
        }

        private ImportPreview NewImportPreview(string sourcePath, string sourceKind, string name)
        {
            var preview = new ImportPreview();
            string cleanName = SanitizeRepoName(name);
            string uniqueName = MakeUniqueRepoName(cleanName);
            preview.sourcePath = sourcePath;
            preview.sourceKind = sourceKind;
            preview.recommendedName = uniqueName;
            preview.nameAdjusted = !String.Equals(cleanName, uniqueName, StringComparison.OrdinalIgnoreCase);
            preview.sampleSkills = new List<string>();
            return preview;
        }

        public Dictionary<string, object> RunZipPreviewSmokeTest(string zipPath, string extractDir, string traversalZipPath)
        {
            ImportPreview preview = BuildZipPreview(zipPath);
            ExtractZipToDirectorySafe(zipPath, extractDir);

            bool previewOk = preview.sourceKind == "zip" &&
                preview.skillCount == 1 &&
                preview.canImport &&
                preview.sampleSkills != null &&
                preview.sampleSkills.Contains("sample-skill");

            bool safeExtracted = File.Exists(Path.Combine(extractDir, "sample-skill", "SKILL.md"));
            bool traversalBlocked = false;
            string traversalMessage = "";
            try
            {
                ExtractZipToDirectorySafe(traversalZipPath, Path.Combine(extractDir, "blocked"));
            }
            catch (InvalidOperationException ex)
            {
                traversalBlocked = true;
                traversalMessage = ex.Message;
            }

            var result = new Dictionary<string, object>();
            result["ok"] = previewOk && safeExtracted && traversalBlocked;
            result["previewOk"] = previewOk;
            result["previewSkillCount"] = preview.skillCount;
            result["previewFileCount"] = preview.fileCount;
            result["recommendedName"] = preview.recommendedName;
            result["sampleSkills"] = preview.sampleSkills == null ? "" : String.Join(", ", preview.sampleSkills.ToArray());
            result["message"] = preview.message;
            result["safeExtracted"] = safeExtracted;
            result["traversalBlocked"] = traversalBlocked;
            result["traversalMessage"] = traversalMessage;
            return result;
        }

        private void ImportLocalSource(Dictionary<string, object> message)
        {
            LoadConfig();
            string sourcePath = GetString(message, "sourcePath");
            string sourceKind = GetString(message, "sourceKind");
            string recommendedName = SanitizeRepoName(GetString(message, "recommendedName"));
            string repoType = GetString(message, "repoType") == "prompt" ? "prompt" : "skills";
            string categoryId = GetString(message, "categoryId");
            string note = GetString(message, "note");
            List<string> tags = GetTags(message, "tags");
            if (String.IsNullOrWhiteSpace(recommendedName)) throw new InvalidOperationException("没有可用的导入名称。");
            if (!IsSafeRepoName(recommendedName)) throw new InvalidOperationException("导入名称包含不安全字符。");
            string finalName = MakeUniqueRepoName(recommendedName);
            bool renamed = !String.Equals(recommendedName, finalName, StringComparison.OrdinalIgnoreCase);

            Directory.CreateDirectory(sourceRoot);
            string dest = Path.Combine(sourceRoot, finalName);

            if (sourceKind == "zip")
            {
                ExtractZipToDirectorySafe(sourcePath, dest);
            }
            else if (sourceKind == "folder")
            {
                CopyDirectorySafe(sourcePath, dest);
            }
            else
            {
                throw new InvalidOperationException("不支持的导入类型。");
            }

            RepoConfig repo = config.repositories.FirstOrDefault(r => String.Equals(r.name, finalName, StringComparison.OrdinalIgnoreCase));
            if (repo == null)
            {
                repo = new RepoConfig();
                config.repositories.Add(repo);
            }
            repo.name = finalName;
            repo.url = "";
            repo.type = repoType;
            repo.mode = repoType == "prompt" ? "do-not-install" : "scan";
            repo.categoryId = categoryId == "auto" ? null : categoryId;
            repo.note = String.IsNullOrWhiteSpace(note) ? "Local import: " + Path.GetFileName(sourcePath) : note;
            repo.tags = tags;
            SaveConfig();
            AppendImportHistory(finalName, sourceKind, sourcePath, dest, repoType, CountSkillFiles(dest), renamed ? recommendedName : "");
            AppendOperationHistory("source.import", "导入本地来源", finalName + " · " + sourceKind, "success");
            Log("info", "已导入本地来源：" + finalName + "。如需撤回，可在仓库来源中选择它并删除来源；本地副本保留在来源目录，便于恢复。");
            Toast("success", renamed ? ("已导入为：" + finalName + "（原名称已存在）") : ("已导入本地来源：" + finalName));
            RunSyncAsync(false);
        }

        private void ExportDiagnostics()
        {
            RunScriptAsync(diagnosticsScript, "");
        }

        private void ExportTroubleshootingBundle()
        {
            try
            {
                Busy(true, "troubleshooting");
                string zipPath = CreateTroubleshootingBundle();
                AppendOperationHistory("troubleshooting.export", "导出排错包", Path.GetFileName(zipPath), "success");
                Toast("success", "已导出排错包");
                Log("info", "排错包已生成：" + zipPath);
                OpenPath(zipPath);
            }
            catch (Exception ex)
            {
                string clean = CompactError(ex.Message);
                Toast("error", "导出排错包失败：" + clean);
                Log("error", "导出排错包失败：" + clean);
                AppendOperationHistory("troubleshooting.error", "导出排错包失败", clean, "error");
            }
            finally
            {
                Busy(false, "");
                SendState();
            }
        }

        public string RunTroubleshootingBundleSmokeTest()
        {
            return CreateTroubleshootingBundle();
        }

        private string CreateTroubleshootingBundle()
        {
            Directory.CreateDirectory(reportsRoot);
            string bundleDir = Path.Combine(reportsRoot, "troubleshooting");
            Directory.CreateDirectory(bundleDir);
            string runId = DateTime.Now.ToString("yyyyMMdd_HHmmss_fff");
            string zipPath = Path.Combine(bundleDir, "skillhub-troubleshooting_" + runId + ".zip");

            using (var archive = ZipFile.Open(zipPath, ZipArchiveMode.Create))
            {
                AddTextEntry(archive, "README.md", BuildTroubleshootingReadme(runId));
                AddSanitizedFile(archive, Path.Combine(reportsRoot, "operation-history.jsonl"), "reports/operation-history.jsonl");
                AddSanitizedFile(archive, Path.Combine(reportsRoot, "import-history.jsonl"), "reports/import-history.jsonl");
                AddSanitizedFile(archive, Path.Combine(reportsRoot, "last-sync.md"), "reports/last-sync.md");
                AddSanitizedFile(archive, Path.Combine(reportsRoot, "latest-diagnostics.json"), "reports/latest-diagnostics.json");
                AddSanitizedFile(archive, Path.Combine(reportsRoot, "zip-preview-test", "latest-zip-preview-test.json"), "reports/zip-preview-test/latest-zip-preview-test.json");
                AddSanitizedFile(archive, Path.Combine(reportsRoot, "zip-preview-test", "latest-zip-preview-test.md"), "reports/zip-preview-test/latest-zip-preview-test.md");
                AddLatestSanitizedFile(archive, Path.Combine(reportsRoot, "diagnostics"), "skillhub-diagnostics_*.md", "reports/diagnostics/latest-diagnostics.md");
                AddLatestSanitizedFile(archive, Path.Combine(reportsRoot, "diagnostics"), "sanitized-config_*.json", "reports/diagnostics/sanitized-config.json");
                AddLatestSanitizedFile(archive, Path.Combine(reportsRoot, "diagnostics"), "sanitized-last-sync_*.md", "reports/diagnostics/sanitized-last-sync.md");
            }

            return zipPath;
        }

        private string BuildTroubleshootingReadme(string runId)
        {
            var sb = new StringBuilder();
            sb.AppendLine("# AI SkillHub 排错包");
            sb.AppendLine();
            sb.AppendLine("- 生成时间：" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
            sb.AppendLine("- 软件版本：v" + AppVersion);
            sb.AppendLine("- 运行编号：" + runId);
            sb.AppendLine();
            sb.AppendLine("这个 zip 用于排查别人电脑上同步、导入、本地 AI 工具接管等问题。它只收集 `app\\reports` 里的报告副本，不包含你的 `skills`、`app\\github_sources`、WebView 缓存或 release 包。");
            sb.AppendLine();
            sb.AppendLine("路径会做基础脱敏：AI SkillHub 根目录会替换为 `{AI_SKILLHUB_ROOT}`，用户目录会替换为 `{USERPROFILE}`，其它 Windows 绝对路径会替换为 `{WINDOWS_PATH}`。");
            sb.AppendLine();
            sb.AppendLine("建议反馈问题时，把这个 zip 连同问题截图一起发送。");
            return sb.ToString();
        }

        private void AddLatestSanitizedFile(ZipArchive archive, string dir, string pattern, string entryName)
        {
            if (!Directory.Exists(dir)) return;
            string latest = Directory.GetFiles(dir, pattern)
                .OrderByDescending(delegate(string path) { return File.GetLastWriteTimeUtc(path); })
                .FirstOrDefault();
            AddSanitizedFile(archive, latest, entryName);
        }

        private void AddSanitizedFile(ZipArchive archive, string sourcePath, string entryName)
        {
            if (String.IsNullOrWhiteSpace(sourcePath) || !File.Exists(sourcePath)) return;
            string text = File.ReadAllText(sourcePath, Encoding.UTF8);
            AddTextEntry(archive, entryName, SanitizeTroubleshootingText(text));
        }

        private void AddTextEntry(ZipArchive archive, string entryName, string text)
        {
            var entry = archive.CreateEntry(entryName, CompressionLevel.Optimal);
            using (var writer = new StreamWriter(entry.Open(), new UTF8Encoding(false)))
            {
                writer.Write(text ?? "");
            }
        }

        private string SanitizeTroubleshootingText(string text)
        {
            if (String.IsNullOrEmpty(text)) return "";
            string sanitized = text;
            string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            sanitized = ReplacePathVariants(sanitized, root, "{AI_SKILLHUB_ROOT}");
            sanitized = ReplacePathVariants(sanitized, profile, "{USERPROFILE}");
            sanitized = Regex.Replace(sanitized, "[A-Za-z]:\\\\\\\\[^\"'\\r\\n]+", "{WINDOWS_PATH}");
            sanitized = Regex.Replace(sanitized, "[A-Za-z]:\\\\[^\"'\\r\\n]+", "{WINDOWS_PATH}");
            sanitized = Regex.Replace(sanitized, "[A-Za-z]:/[^\"'\\r\\n]+", "{WINDOWS_PATH}");
            return sanitized;
        }

        private string ReplacePathVariants(string text, string path, string token)
        {
            if (String.IsNullOrWhiteSpace(path)) return text;
            string clean = path.TrimEnd('\\', '/');
            string result = text.Replace(clean, token);
            result = result.Replace(clean.Replace("\\", "/"), token);
            result = result.Replace(clean.Replace("\\", "\\\\"), token);
            return result;
        }

        private void RunShareCheck()
        {
            RunScriptAsync(diagnosticsScript, "-Quiet -SimulateMissingCodex");
        }

        private void OpenSourcePath(Dictionary<string, object> message)
        {
            LoadConfig();
            string name = GetString(message, "name");
            if (!IsSafeRepoName(name)) throw new InvalidOperationException("来源名称不安全。");
            RepoView repo = LoadRepositories().FirstOrDefault(r => String.Equals(r.name, name, StringComparison.OrdinalIgnoreCase));
            if (repo == null || String.IsNullOrWhiteSpace(repo.path)) throw new InvalidOperationException("没有找到这个来源目录。");
            OpenPath(repo.path);
        }

        private void SetDailyUpdate(bool enabled)
        {
            RunScriptAsync(enabled ? installTaskScript : uninstallTaskScript, "");
        }

        private void SetManageLinks(bool enabled)
        {
            LoadConfig();
            config.manageAgentLinks = enabled;
            SaveConfig();
            if (enabled) RunScriptAsync(linksScript, "-Quiet");
            else SendState();
        }

        private void RunSyncAsync(bool pull)
        {
            RunScriptAsync(skillHubScript, pull ? "" : "-NoPull");
        }

        private async void RunScriptAsync(string script, string extraArgs)
        {
            try
            {
                string fullScript = Path.GetFullPath(script);
                string appFull = Path.GetFullPath(appRoot).TrimEnd('\\') + "\\";
                if (!fullScript.StartsWith(appFull, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("拒绝运行项目目录外的脚本。");
                if (!File.Exists(fullScript)) throw new FileNotFoundException("脚本不存在", fullScript);

                Busy(true, Path.GetFileName(fullScript));
                string output = await Task.Run(delegate { return RunProcess(PowerShellPath(), "-NoProfile -ExecutionPolicy Bypass -File \"" + fullScript + "\"" + (String.IsNullOrWhiteSpace(extraArgs) ? "" : " " + extraArgs)); });
                Log("info", output.Trim());
                AppendOperationHistory("script.success", "操作完成", Path.GetFileName(fullScript), "success");
                Toast("success", "操作完成");
            }
            catch (Exception ex)
            {
                Toast("error", "运行失败：" + CompactError(ex.Message));
                Log("error", CompactError(ex.Message) + "。详细信息可导出诊断包查看。");
                AppendOperationHistory("script.error", "操作失败", CompactError(ex.Message), "error");
            }
            finally
            {
                Busy(false, "");
                SendState();
            }
        }

        private string RunProcess(string fileName, string arguments)
        {
            var psi = new ProcessStartInfo();
            psi.FileName = fileName;
            psi.Arguments = arguments;
            psi.WorkingDirectory = appRoot;
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.CreateNoWindow = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            using (var p = Process.Start(psi))
            {
                string stdout = p.StandardOutput.ReadToEnd();
                string stderr = p.StandardError.ReadToEnd();
                p.WaitForExit();
                if (p.ExitCode != 0) throw new InvalidOperationException((stderr.Length > 0 ? stderr : stdout).Trim());
                return stdout + (stderr.Length > 0 ? Environment.NewLine + stderr : "");
            }
        }

        private string CompactError(string message)
        {
            if (String.IsNullOrWhiteSpace(message)) return "未知错误。";
            string[] lines = message.Replace("\r", "").Split('\n');
            foreach (string line in lines)
            {
                string clean = line.Trim();
                if (clean.Length == 0) continue;
                if (clean.StartsWith("At ", StringComparison.OrdinalIgnoreCase)) continue;
                if (clean.StartsWith("+ ", StringComparison.OrdinalIgnoreCase)) continue;
                if (clean.StartsWith("CategoryInfo", StringComparison.OrdinalIgnoreCase)) continue;
                if (clean.StartsWith("FullyQualifiedErrorId", StringComparison.OrdinalIgnoreCase)) continue;
                return clean.Length > 260 ? clean.Substring(0, 257) + "..." : clean;
            }
            string fallback = message.Trim();
            return fallback.Length > 260 ? fallback.Substring(0, 257) + "..." : fallback;
        }

        private string GetGitCommit(string dir)
        {
            if (!Directory.Exists(Path.Combine(dir, ".git"))) return "";
            try { return RunProcess("git", "-C \"" + dir + "\" rev-parse --short HEAD").Trim(); }
            catch { return ""; }
        }

        private int CountSkillFiles(string dir)
        {
            if (!Directory.Exists(dir)) return 0;
            int count = 0;
            foreach (string file in EnumerateSafeFiles(dir))
            {
                if (!String.Equals(Path.GetFileName(file), "SKILL.md", StringComparison.OrdinalIgnoreCase)) continue;
                count++;
                if (count >= 999) break;
            }
            return count;
        }

        private bool IsDailyTaskEnabled()
        {
            try
            {
                string schtasks = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "schtasks.exe");
                RunProcess(schtasks, "/Query /TN AISkillHubDailyUpdate /FO LIST");
                return true;
            }
            catch { return false; }
        }

        private string GetLastSync()
        {
            string report = Path.Combine(reportsRoot, "last-sync.md");
            if (!File.Exists(report)) return "";
            return File.GetLastWriteTime(report).ToString("yyyy-MM-dd HH:mm:ss");
        }

        private Dictionary<string, object> LoadLinkStatus(int skillCount)
        {
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string claudeRoot = Path.Combine(home, ".claude");
            string claudeSkills = Path.Combine(claudeRoot, "skills");
            string codexRoot = Path.Combine(home, ".codex");
            string codexSkills = Path.Combine(codexRoot, "skills");
            string agentsSkills = Path.Combine(home, ".agents", "skills");
            string antigravityRoot = Path.Combine(home, ".gemini", "antigravity");
            string antigravitySkills = Path.Combine(antigravityRoot, "skills");
            var d = new Dictionary<string, object>();
            d["claudeDetected"] = Directory.Exists(claudeRoot) || Directory.Exists(claudeSkills);
            d["claude"] = Directory.Exists(claudeSkills);
            d["codexDetected"] = Directory.Exists(codexRoot) || Directory.Exists(codexSkills) || Directory.Exists(agentsSkills);
            d["codexSkills"] = Directory.Exists(codexSkills);
            d["agentsSkills"] = Directory.Exists(agentsSkills);
            d["antigravityDetected"] = Directory.Exists(antigravityRoot) || Directory.Exists(antigravitySkills);
            d["antigravity"] = Directory.Exists(antigravitySkills);
            d["codexCount"] = CountCodexLinks(skillCount);
            return d;
        }

        private int CountCodexLinks(int max)
        {
            try
            {
                string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                string[] roots = new string[] {
                    Path.Combine(home, ".codex", "skills"),
                    Path.Combine(home, ".agents", "skills")
                };
                var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                int count = 0;
                foreach (string rootDir in roots)
                {
                    if (!Directory.Exists(rootDir)) continue;
                    foreach (string dir in Directory.GetDirectories(rootDir))
                    {
                        string key = Path.GetFileName(dir);
                        if (!seen.Add(key)) continue;
                        if (File.Exists(Path.Combine(dir, "SKILL.md"))) count++;
                    }
                }
                return count > max ? max : count;
            }
            catch { return 0; }
        }

        private Dictionary<string, object> LoadDiagnosticsOverview()
        {
            string latest = Path.Combine(reportsRoot, "latest-diagnostics.json");
            var overview = new Dictionary<string, object>();
            overview["available"] = false;
            overview["overallStatus"] = "info";
            overview["generatedAt"] = "";
            overview["ok"] = 0;
            overview["warn"] = 0;
            overview["error"] = 0;
            overview["info"] = 0;
            overview["skills"] = 0;
            overview["repositories"] = 0;
            overview["riskFindings"] = 0;
            overview["checks"] = new List<object>();
            overview["agents"] = new List<object>();

            if (!File.Exists(latest)) return overview;

            try
            {
                var raw = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(latest, Encoding.UTF8));
                overview["available"] = true;
                overview["overallStatus"] = DictString(raw, "overallStatus", "info");
                overview["generatedAt"] = DictString(raw, "generatedAt", "");

                var summary = Dict(raw, "summary");
                if (summary != null)
                {
                    overview["ok"] = DictInt(summary, "ok");
                    overview["warn"] = DictInt(summary, "warn");
                    overview["error"] = DictInt(summary, "error");
                    overview["info"] = DictInt(summary, "info");
                    overview["skills"] = DictInt(summary, "skills");
                    overview["repositories"] = DictInt(summary, "repositories");
                    overview["riskFindings"] = DictInt(summary, "riskFindings");
                }

                var wanted = new List<string>
                {
                    "project.root",
                    "project.skills",
                    "tool.git",
                    "tool.node",
                    "tool.webview2",
                    "config.githubUrls",
                    "import.zipPreviewTest",
                    "skills.scan",
                    "skills.health",
                    "skills.duplicates",
                    "security.patterns"
                };
                var checkById = new Dictionary<string, Dictionary<string, object>>();
                foreach (object item in List(raw, "checks"))
                {
                    var check = item as Dictionary<string, object>;
                    if (check == null) continue;
                    string id = DictString(check, "id", "");
                    if (id.Length > 0 && !checkById.ContainsKey(id)) checkById[id] = check;
                }

                var checks = new List<object>();
                foreach (string id in wanted)
                {
                    if (!checkById.ContainsKey(id)) continue;
                    var check = checkById[id];
                    checks.Add(new Dictionary<string, object>
                    {
                        { "id", id },
                        { "name", DictString(check, "name", id) },
                        { "status", DictString(check, "status", "info") },
                        { "summary", DictString(check, "summary", "") },
                        { "fix", DictString(check, "fix", "") }
                    });
                }
                overview["checks"] = checks;

                var agents = new List<object>();
                foreach (object item in List(raw, "agents"))
                {
                    var agent = item as Dictionary<string, object>;
                    if (agent == null) continue;
                    bool detected = DictBool(agent, "detected");
                    bool hasSkillsDir = false;
                    bool writable = false;
                    bool linked = false;
                    string firstPath = "";
                    foreach (object dirItem in List(agent, "skillsDirs"))
                    {
                        var dir = dirItem as Dictionary<string, object>;
                        if (dir == null) continue;
                        if (firstPath.Length == 0) firstPath = DictString(dir, "path", "");
                        hasSkillsDir = hasSkillsDir || DictBool(dir, "exists");
                        writable = writable || DictBool(dir, "writable");
                        linked = linked || DictBool(dir, "isLink");
                    }
                    agents.Add(new Dictionary<string, object>
                    {
                        { "id", DictString(agent, "id", "") },
                        { "name", DictString(agent, "name", "") },
                        { "detected", detected },
                        { "hasSkillsDir", hasSkillsDir },
                        { "writable", writable },
                        { "linked", linked },
                        { "path", firstPath }
                    });
                }
                overview["agents"] = agents;
            }
            catch (Exception ex)
            {
                overview["available"] = false;
                overview["overallStatus"] = "warn";
                overview["checks"] = new List<object>
                {
                    new Dictionary<string, object>
                    {
                        { "id", "diagnostics.parse" },
                        { "name", "诊断报告" },
                        { "status", "warn" },
                        { "summary", "最近诊断报告读取失败。" },
                        { "fix", ex.Message }
                    }
                };
            }

            return overview;
        }

        private List<Dictionary<string, object>> LoadOperationHistory()
        {
            var entries = new List<Dictionary<string, object>>();
            try
            {
                string operationLog = Path.Combine(reportsRoot, "operation-history.jsonl");
                if (File.Exists(operationLog))
                {
                    string[] lines = File.ReadAllLines(operationLog, Encoding.UTF8);
                    int start = Math.Max(0, lines.Length - 40);
                    for (int i = start; i < lines.Length; i++)
                    {
                        string line = lines[i].Trim();
                        if (line.Length == 0) continue;
                        try
                        {
                            var item = json.Deserialize<Dictionary<string, object>>(line);
                            AddHistoryEntry(entries,
                                DictString(item, "time", ""),
                                DictString(item, "title", "操作记录"),
                                DictString(item, "detail", ""),
                                DictString(item, "kind", "operation"),
                                DictString(item, "status", "info"));
                        }
                        catch { }
                    }
                }

                string importLog = Path.Combine(reportsRoot, "import-history.jsonl");
                if (File.Exists(importLog))
                {
                    string[] lines = File.ReadAllLines(importLog, Encoding.UTF8);
                    int start = Math.Max(0, lines.Length - 20);
                    for (int i = start; i < lines.Length; i++)
                    {
                        string line = lines[i].Trim();
                        if (line.Length == 0) continue;
                        try
                        {
                            var item = json.Deserialize<Dictionary<string, object>>(line);
                            AddHistoryEntry(entries,
                                DictString(item, "time", ""),
                                "导入来源",
                                DictString(item, "name", "") + " · " + DictString(item, "sourceKind", ""),
                                "import",
                                "success");
                        }
                        catch { }
                    }
                }

                string latestDiagnostics = Path.Combine(reportsRoot, "latest-diagnostics.json");
                if (File.Exists(latestDiagnostics))
                {
                    var raw = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(latestDiagnostics, Encoding.UTF8));
                    AddHistoryEntry(entries,
                        DictString(raw, "generatedAt", File.GetLastWriteTime(latestDiagnostics).ToString("o")),
                        "完成系统体检",
                        "状态 " + DictString(raw, "overallStatus", "info"),
                        "diagnostics",
                        DictString(raw, "overallStatus", "info"));
                }

                string lastSync = Path.Combine(reportsRoot, "last-sync.md");
                if (File.Exists(lastSync))
                {
                    AddHistoryEntry(entries,
                        File.GetLastWriteTime(lastSync).ToString("o"),
                        "完成技能同步",
                        "已更新同步报告",
                        "sync",
                        "success");
                }

                string zipTest = Path.Combine(reportsRoot, "zip-preview-test", "latest-zip-preview-test.json");
                if (File.Exists(zipTest))
                {
                    var raw = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(zipTest, Encoding.UTF8));
                    bool ok = DictBool(raw, "ok");
                    AddHistoryEntry(entries,
                        DictString(raw, "generatedAt", File.GetLastWriteTime(zipTest).ToString("o")),
                        "Zip 导入预览测试",
                        ok ? "安全解压与 zip slip 拦截通过" : "测试未通过，请查看报告",
                        "zip-preview",
                        ok ? "success" : "error");
                }
            }
            catch
            {
            }

            entries.Sort(delegate(Dictionary<string, object> a, Dictionary<string, object> b)
            {
                return String.Compare(Convert.ToString(b["time"]), Convert.ToString(a["time"]), StringComparison.OrdinalIgnoreCase);
            });
            return entries.Take(14).ToList();
        }

        private void AddHistoryEntry(List<Dictionary<string, object>> entries, string time, string title, string detail, string kind, string status)
        {
            if (entries == null || String.IsNullOrWhiteSpace(title)) return;
            var entry = new Dictionary<string, object>();
            entry["time"] = String.IsNullOrWhiteSpace(time) ? DateTime.Now.ToString("o") : time;
            entry["title"] = title;
            entry["detail"] = detail ?? "";
            entry["kind"] = kind ?? "operation";
            entry["status"] = status ?? "info";
            entries.Add(entry);
        }

        private void AppendOperationHistory(string kind, string title, string detail, string status)
        {
            try
            {
                Directory.CreateDirectory(reportsRoot);
                var entry = new Dictionary<string, object>();
                entry["time"] = DateTime.Now.ToString("o");
                entry["kind"] = kind ?? "operation";
                entry["title"] = title ?? "操作记录";
                entry["detail"] = detail ?? "";
                entry["status"] = status ?? "info";
                File.AppendAllText(Path.Combine(reportsRoot, "operation-history.jsonl"), json.Serialize(entry) + Environment.NewLine, new UTF8Encoding(false));
            }
            catch
            {
            }
        }

        private Dictionary<string, object> Dict(Dictionary<string, object> source, string key)
        {
            if (source == null || !source.ContainsKey(key)) return null;
            return source[key] as Dictionary<string, object>;
        }

        private IEnumerable<object> List(Dictionary<string, object> source, string key)
        {
            if (source == null || !source.ContainsKey(key) || source[key] == null) yield break;
            var arrayList = source[key] as ArrayList;
            if (arrayList != null)
            {
                foreach (object item in arrayList) yield return item;
                yield break;
            }
            if (source[key] is string) yield break;
            var enumerable = source[key] as IEnumerable;
            if (enumerable == null) yield break;
            foreach (object item in enumerable) yield return item;
        }

        private string DictString(Dictionary<string, object> source, string key, string fallback)
        {
            if (source == null || !source.ContainsKey(key) || source[key] == null) return fallback;
            return Convert.ToString(source[key]);
        }

        private int DictInt(Dictionary<string, object> source, string key)
        {
            if (source == null || !source.ContainsKey(key) || source[key] == null) return 0;
            try { return Convert.ToInt32(source[key]); }
            catch { return 0; }
        }

        private bool DictBool(Dictionary<string, object> source, string key)
        {
            if (source == null || !source.ContainsKey(key) || source[key] == null) return false;
            if (source[key] is bool) return (bool)source[key];
            bool value;
            return Boolean.TryParse(Convert.ToString(source[key]), out value) && value;
        }

        private IEnumerable<string> EnumerateSafeFiles(string rootDir)
        {
            var stack = new Stack<string>();
            stack.Push(rootDir);
            while (stack.Count > 0)
            {
                string current = stack.Pop();
                string leaf = Path.GetFileName(current);
                if (leaf.Equals(".git", StringComparison.OrdinalIgnoreCase) ||
                    leaf.Equals("node_modules", StringComparison.OrdinalIgnoreCase) ||
                    leaf.Equals("__pycache__", StringComparison.OrdinalIgnoreCase))
                    continue;

                string[] files = new string[0];
                string[] dirs = new string[0];
                try { files = Directory.GetFiles(current); } catch { }
                foreach (string file in files) yield return file;
                try { dirs = Directory.GetDirectories(current); } catch { }
                foreach (string dir in dirs) stack.Push(dir);
            }
        }

        private string RelativePath(string rootDir, string file)
        {
            string rootFull = Path.GetFullPath(rootDir).TrimEnd('\\') + "\\";
            string full = Path.GetFullPath(file);
            return full.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase) ? full.Substring(rootFull.Length) : full;
        }

        private bool LooksLikePromptOrReference(string path)
        {
            string text = (path ?? "").Replace('\\', '/').ToLowerInvariant();
            if (text.Contains("prompt") || text.Contains("prompts") || text.Contains("readme") || text.Contains("awesome")) return true;
            if (text.EndsWith(".md") && (text.Contains("examples/") || text.Contains("docs/") || text.Contains("reference"))) return true;
            return false;
        }

        private string SanitizeRepoName(string value)
        {
            string name = value ?? "";
            name = name.Trim();
            name = Regex.Replace(name, "\\s+", "-");
            name = Regex.Replace(name, "[^A-Za-z0-9_.-]", "-");
            name = Regex.Replace(name, "-{2,}", "-").Trim('-', '.', '_');
            return name.Length > 80 ? name.Substring(0, 80).Trim('-', '.', '_') : name;
        }

        private string MakeUniqueRepoName(string baseName)
        {
            string clean = SanitizeRepoName(baseName);
            if (String.IsNullOrWhiteSpace(clean)) clean = "local-source";
            if (config == null)
            {
                try { LoadConfig(); }
                catch { }
            }

            var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (config != null && config.repositories != null)
            {
                foreach (var repo in config.repositories)
                {
                    if (!String.IsNullOrWhiteSpace(repo.name)) used.Add(repo.name);
                    else if (!String.IsNullOrWhiteSpace(repo.url)) used.Add(GetRepoNameFromUrl(repo.url));
                }
            }
            if (Directory.Exists(sourceRoot))
            {
                foreach (string dir in Directory.GetDirectories(sourceRoot))
                    used.Add(Path.GetFileName(dir));
            }

            string candidate = clean;
            int index = 2;
            while (used.Contains(candidate) || Directory.Exists(Path.Combine(sourceRoot, candidate)))
            {
                candidate = clean + "-" + index.ToString();
                index++;
            }
            return candidate;
        }

        private void AppendImportHistory(string name, string sourceKind, string sourcePath, string destination, string repoType, int skillCount, string renamedFrom)
        {
            try
            {
                Directory.CreateDirectory(reportsRoot);
                var entry = new Dictionary<string, object>();
                entry["time"] = DateTime.Now.ToString("o");
                entry["name"] = name;
                entry["renamedFrom"] = renamedFrom ?? "";
                entry["sourceKind"] = sourceKind ?? "";
                entry["sourcePath"] = sourcePath ?? "";
                entry["destination"] = destination ?? "";
                entry["type"] = repoType ?? "";
                entry["skillCount"] = skillCount;
                entry["rollbackHint"] = "在仓库来源中删除该来源并重新同步；如需彻底清理，再手动删除 app\\github_sources\\" + name;
                File.AppendAllText(Path.Combine(reportsRoot, "import-history.jsonl"), json.Serialize(entry) + Environment.NewLine, new UTF8Encoding(false));
            }
            catch
            {
            }
        }

        private void CopyDirectorySafe(string source, string destination)
        {
            string sourceFull = Path.GetFullPath(source).TrimEnd('\\') + "\\";
            string destFull = Path.GetFullPath(destination).TrimEnd('\\') + "\\";
            if (!Directory.Exists(sourceFull)) throw new DirectoryNotFoundException(sourceFull);
            Directory.CreateDirectory(destFull);
            foreach (string dir in Directory.GetDirectories(sourceFull, "*", SearchOption.AllDirectories))
            {
                string relative = dir.Substring(sourceFull.Length);
                if (ShouldSkipRelativePath(relative)) continue;
                Directory.CreateDirectory(Path.Combine(destFull, relative));
            }
            foreach (string file in Directory.GetFiles(sourceFull, "*", SearchOption.AllDirectories))
            {
                string relative = file.Substring(sourceFull.Length);
                if (ShouldSkipRelativePath(relative)) continue;
                string target = Path.Combine(destFull, relative);
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                File.Copy(file, target, false);
            }
        }

        private bool ShouldSkipRelativePath(string relative)
        {
            string normalized = (relative ?? "").Replace('/', '\\');
            foreach (string part in normalized.Split('\\'))
            {
                if (part.Equals(".git", StringComparison.OrdinalIgnoreCase) ||
                    part.Equals("node_modules", StringComparison.OrdinalIgnoreCase) ||
                    part.Equals("__pycache__", StringComparison.OrdinalIgnoreCase))
                    return true;
            }
            return false;
        }

        private void ExtractZipToDirectorySafe(string zipPath, string destination)
        {
            string zipFull = Path.GetFullPath(zipPath);
            if (!File.Exists(zipFull)) throw new FileNotFoundException("zip 文件不存在", zipFull);
            string destFull = Path.GetFullPath(destination).TrimEnd('\\') + "\\";
            Directory.CreateDirectory(destFull);
            using (var archive = ZipFile.OpenRead(zipFull))
            {
                foreach (var entry in archive.Entries)
                {
                    if (String.IsNullOrWhiteSpace(entry.FullName)) continue;
                    string normalizedName = entry.FullName.Replace('/', '\\');
                    if (ShouldSkipRelativePath(normalizedName)) continue;
                    string target = Path.GetFullPath(Path.Combine(destFull, normalizedName));
                    if (!target.StartsWith(destFull, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("zip 内含不安全路径，已拒绝导入。");
                    if (entry.FullName.EndsWith("/", StringComparison.Ordinal) || entry.FullName.EndsWith("\\", StringComparison.Ordinal))
                    {
                        Directory.CreateDirectory(target);
                        continue;
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    entry.ExtractToFile(target, false);
                }
            }
        }

        private void OpenPath(string path)
        {
            string full = Path.GetFullPath(path);
            string rootFull = Path.GetFullPath(root).TrimEnd('\\') + "\\";
            string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile).TrimEnd('\\') + "\\";
            if (!full.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase) &&
                !full.StartsWith(profile, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("拒绝打开项目目录外的路径。");
            if (File.Exists(full) || Directory.Exists(full))
                Process.Start(new ProcessStartInfo { FileName = full, UseShellExecute = true });
        }

        private string PowerShellPath()
        {
            string path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
            if (!File.Exists(path)) throw new FileNotFoundException("Missing Windows PowerShell", path);
            return path;
        }

        private bool IsSafeGithubUrl(string url)
        {
            string clean = NormalizeGithubUrl(url);
            return Regex.IsMatch(clean, "^https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\\.git)?$");
        }

        private bool IsSafeRepoName(string name)
        {
            return Regex.IsMatch(name ?? "", "^[A-Za-z0-9_.-]+$");
        }

        private string GetRepoNameFromUrl(string url)
        {
            if (String.IsNullOrWhiteSpace(url)) return "";
            string clean = NormalizeGithubUrl(url);
            string name = clean.Substring(clean.LastIndexOf('/') + 1);
            if (name.EndsWith(".git", StringComparison.OrdinalIgnoreCase)) name = name.Substring(0, name.Length - 4);
            return name;
        }

        private string NormalizeGithubUrl(string url)
        {
            if (String.IsNullOrWhiteSpace(url)) return "";
            string clean = url.Trim();
            clean = Regex.Replace(clean, "^https\\s*:\\s*/\\s*/\\s*", "https://", RegexOptions.IgnoreCase);
            clean = Regex.Replace(clean, "\\s+", "");
            return clean.TrimEnd('/');
        }

        private string GetString(Dictionary<string, object> message, string key)
        {
            if (message == null || !message.ContainsKey(key) || message[key] == null) return "";
            return Convert.ToString(message[key]);
        }

        private bool GetBool(Dictionary<string, object> message, string key)
        {
            if (message == null || !message.ContainsKey(key) || message[key] == null) return false;
            if (message[key] is bool) return (bool)message[key];
            bool value;
            return Boolean.TryParse(Convert.ToString(message[key]), out value) && value;
        }

        private List<string> GetTags(Dictionary<string, object> message, string key)
        {
            var values = new List<string>();
            if (message == null || !message.ContainsKey(key) || message[key] == null) return values;
            object raw = message[key];
            string asText = raw as string;
            if (asText != null)
            {
                values.AddRange(Regex.Split(asText, "[,，;；\\r\\n]+"));
                return NormalizeTags(values);
            }

            var enumerable = raw as IEnumerable;
            if (enumerable != null)
            {
                foreach (object item in enumerable)
                {
                    if (item == null) continue;
                    values.Add(Convert.ToString(item));
                }
            }
            return NormalizeTags(values);
        }

        private List<string> NormalizeTags(IEnumerable<string> values)
        {
            var result = new List<string>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (values == null) return result;
            foreach (string value in values)
            {
                string clean = CleanTag(value);
                if (clean.Length == 0 || seen.Contains(clean)) continue;
                seen.Add(clean);
                result.Add(clean);
                if (result.Count >= 12) break;
            }
            return result;
        }

        private string CleanTag(string value)
        {
            if (String.IsNullOrWhiteSpace(value)) return "";
            string clean = Regex.Replace(value.Trim(), "[\\r\\n\\t|]+", " ");
            clean = Regex.Replace(clean, "\\s{2,}", " ").Trim();
            if (clean.Length > 28) clean = clean.Substring(0, 28).Trim();
            return clean;
        }

        private void Busy(bool busy, string label)
        {
            Post(new Dictionary<string, object> { { "type", "busy" }, { "busy", busy }, { "label", label } });
        }

        private void Toast(string tone, string message)
        {
            Post(new Dictionary<string, object> { { "type", "toast" }, { "tone", tone }, { "message", message } });
        }

        private void Log(string level, string message)
        {
            if (String.IsNullOrWhiteSpace(message)) return;
            Post(new Dictionary<string, object> { { "type", "log" }, { "level", level }, { "message", message } });
        }

        private void Post(Dictionary<string, object> payload)
        {
            if (web == null || web.CoreWebView2 == null || IsDisposed) return;
            string text = json.Serialize(payload);
            if (InvokeRequired)
            {
                BeginInvoke(new Action(delegate { web.CoreWebView2.PostWebMessageAsJson(text); }));
            }
            else
            {
                web.CoreWebView2.PostWebMessageAsJson(text);
            }
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_NCHITTEST)
            {
                base.WndProc(ref m);
                if ((int)m.Result == HTCLIENT)
                {
                    Point p = PointToClient(new Point((short)((long)m.LParam & 0xffff), (short)(((long)m.LParam >> 16) & 0xffff)));
                    int grip = 8;
                    bool left = p.X <= grip;
                    bool right = p.X >= Width - grip;
                    bool top = p.Y <= grip;
                    bool bottom = p.Y >= Height - grip;
                    if (left && top) m.Result = (IntPtr)HTTOPLEFT;
                    else if (right && top) m.Result = (IntPtr)HTTOPRIGHT;
                    else if (left && bottom) m.Result = (IntPtr)HTBOTTOMLEFT;
                    else if (right && bottom) m.Result = (IntPtr)HTBOTTOMRIGHT;
                    else if (left) m.Result = (IntPtr)HTLEFT;
                    else if (right) m.Result = (IntPtr)HTRIGHT;
                    else if (top) m.Result = (IntPtr)HTTOP;
                    else if (bottom) m.Result = (IntPtr)HTBOTTOM;
                }
                return;
            }
            base.WndProc(ref m);
        }

        [DllImport("user32.dll")]
        private static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        private void BeginDragMove()
        {
            if (WindowState == FormWindowState.Maximized) return;
            ReleaseCapture();
            SendMessage(Handle, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
        }

        private void BeginResize(string edge)
        {
            if (WindowState == FormWindowState.Maximized) return;
            int hit = 0;
            switch (edge)
            {
                case "left": hit = HTLEFT; break;
                case "right": hit = HTRIGHT; break;
                case "top": hit = HTTOP; break;
                case "bottom": hit = HTBOTTOM; break;
                case "top-left": hit = HTTOPLEFT; break;
                case "top-right": hit = HTTOPRIGHT; break;
                case "bottom-left": hit = HTBOTTOMLEFT; break;
                case "bottom-right": hit = HTBOTTOMRIGHT; break;
            }
            if (hit == 0) return;
            ReleaseCapture();
            SendMessage(Handle, WM_NCLBUTTONDOWN, (IntPtr)hit, IntPtr.Zero);
        }
    }

    public class SkillHubConfig
    {
        public int version { get; set; }
        public string githubSourcesFolder { get; set; }
        public string activeSkillsFolder { get; set; }
        public bool manageAgentLinks { get; set; }
        public bool autoDiscoverManualRepos { get; set; }
        public List<string> preferredPathFragments { get; set; }
        public List<RepoConfig> repositories { get; set; }
    }

    public class RepoConfig
    {
        public string name { get; set; }
        public string url { get; set; }
        public string type { get; set; }
        public string mode { get; set; }
        public List<string> skillPaths { get; set; }
        public string categoryId { get; set; }
        public string note { get; set; }
        public List<string> tags { get; set; }
    }

    public class RepoView
    {
        public string name { get; set; }
        public string url { get; set; }
        public string type { get; set; }
        public string mode { get; set; }
        public string categoryId { get; set; }
        public string note { get; set; }
        public List<string> tags { get; set; }
        public string path { get; set; }
        public bool exists { get; set; }
        public string commit { get; set; }
        public bool isGitRepo { get; set; }
        public string sourceKind { get; set; }
        public int skillCount { get; set; }
        public bool enabled { get; set; }
        public bool configured { get; set; }
    }

    public class SkillView
    {
        public string name { get; set; }
        public string repo { get; set; }
        public string categoryId { get; set; }
        public string note { get; set; }
        public List<string> tags { get; set; }
        public string description { get; set; }
        public string target { get; set; }
        public string localPath { get; set; }
        public string mode { get; set; }
    }

    public class ManagedSkill
    {
        public string Skill { get; set; }
        public string Repo { get; set; }
        public string CategoryId { get; set; }
        public string Note { get; set; }
        public string Description { get; set; }
        public string Target { get; set; }
    }

    public class SkillMeta
    {
        public string name = "";
        public string description = "";
    }

    public class ImportPreview
    {
        public string sourcePath { get; set; }
        public string sourceKind { get; set; }
        public string recommendedName { get; set; }
        public int skillCount { get; set; }
        public int promptHintCount { get; set; }
        public int fileCount { get; set; }
        public bool hasReadme { get; set; }
        public bool hasSkillMdAtRoot { get; set; }
        public bool canImport { get; set; }
        public bool nameAdjusted { get; set; }
        public string message { get; set; }
        public List<string> sampleSkills { get; set; }
    }
}

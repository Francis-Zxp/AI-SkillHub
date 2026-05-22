using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace AISkillHub
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            if (args.Any(a => a.Equals("--self-test", StringComparison.OrdinalIgnoreCase)))
            {
                Environment.ExitCode = SkillHubDiagnostics.Run();
                return;
            }
            Application.Run(new SkillHubForm());
        }
    }

    internal static class SkillHubDiagnostics
    {
        public static int Run()
        {
            try
            {
                string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
                string app = Path.Combine(root, "app");
                string[] required =
                {
                    Path.Combine(root, "AI SkillHub.exe"),
                    Path.Combine(root, "skills"),
                    Path.Combine(app, "SkillHub.ps1"),
                    Path.Combine(app, "Manage-AgentSkillLinks.ps1"),
                    Path.Combine(app, "skillhub.config.json"),
                    Path.Combine(app, "assets", "AI SkillHub.ico"),
                    Path.Combine(app, "assets", "AI SkillHub.logo.png")
                };
                foreach (string item in required)
                {
                    if (!File.Exists(item) && !Directory.Exists(item))
                        throw new FileNotFoundException(item);
                }
                using (var form = new SkillHubForm())
                {
                    form.CreateControl();
                    form.WindowState = FormWindowState.Maximized;
                    form.Size = Screen.PrimaryScreen.WorkingArea.Size;
                    form.PerformLayout();
                    form.WindowState = FormWindowState.Normal;
                    form.Size = new Size(1280, 820);
                    form.PerformLayout();
                }
                string report = Path.Combine(app, "reports", "native-self-test.txt");
                Directory.CreateDirectory(Path.GetDirectoryName(report));
                File.WriteAllText(report, "OK " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"), new UTF8Encoding(true));
                return 0;
            }
            catch (Exception ex)
            {
                try
                {
                    string report = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app", "reports", "native-self-test.txt");
                    Directory.CreateDirectory(Path.GetDirectoryName(report));
                    File.WriteAllText(report, "FAILED " + ex, new UTF8Encoding(true));
                }
                catch { }
                return 1;
            }
        }
    }

    public sealed class SkillHubConfig
    {
        public int version { get; set; }
        public string githubSourcesFolder { get; set; }
        public string activeSkillsFolder { get; set; }
        public bool manageAgentLinks { get; set; }
        public bool autoDiscoverManualRepos { get; set; }
        public List<string> preferredPathFragments { get; set; }
        public List<RepositoryConfig> repositories { get; set; }
    }

    public sealed class RepositoryConfig
    {
        public string name { get; set; }
        public string url { get; set; }
        public string type { get; set; }
        public string mode { get; set; }
        public string categoryId { get; set; }
        public string note { get; set; }
        public List<string> skillPaths { get; set; }
    }

    public sealed class SkillState
    {
        public string Skill { get; set; }
        public string Repo { get; set; }
        public string CategoryId { get; set; }
        public string Note { get; set; }
        public string Description { get; set; }
        public string Target { get; set; }
    }

    internal sealed class CategoryItem
    {
        public string Id;
        public string Zh;
        public string En;
        public string Ko;
        public string Label(string lang)
        {
            if (lang == "en") return En;
            if (lang == "ko") return Ko;
            return Zh;
        }
        public override string ToString() { return Zh; }
    }

    internal sealed class PillButton : Button
    {
        public Color Fill = Theme.Surface2;
        public Color HoverFill = Theme.Surface3;
        public Color PressFill = Theme.AccentDim;
        public Color Border = Theme.Border;
        public Color TextColor = Theme.Text;
        public int Radius = 16;

        public PillButton()
        {
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0;
            BackColor = Color.Transparent;
            ForeColor = TextColor;
            Height = 42;
            Cursor = Cursors.Hand;
            Font = Theme.Font(10.5f, FontStyle.Bold);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            var rect = new Rectangle(0, 0, Width - 1, Height - 1);
            var color = Fill;
            if (ClientRectangle.Contains(PointToClient(Cursor.Position)))
                color = MouseButtons == MouseButtons.Left ? PressFill : HoverFill;
            using (var path = Theme.Round(rect, Radius))
            using (var brush = new SolidBrush(color))
            using (var pen = new Pen(Border, 1))
            {
                e.Graphics.FillPath(brush, path);
                e.Graphics.DrawPath(pen, path);
            }
            TextRenderer.DrawText(e.Graphics, Text, Font, rect, TextColor,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
        }
    }

    internal enum CaptionButtonKind
    {
        Minimize,
        Maximize,
        Close
    }

    internal sealed class CaptionButton : Control
    {
        private readonly CaptionButtonKind kind;
        private bool hovering;
        private bool pressing;

        public CaptionButton(CaptionButtonKind kind)
        {
            this.kind = kind;
            Width = 36;
            Height = 32;
            Cursor = Cursors.Hand;
            BackColor = Theme.Background;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
        }

        protected override void OnPaintBackground(PaintEventArgs pevent)
        {
        }

        protected override void OnMouseEnter(EventArgs e)
        {
            hovering = true;
            Invalidate();
            base.OnMouseEnter(e);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            hovering = false;
            pressing = false;
            Invalidate();
            base.OnMouseLeave(e);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            pressing = true;
            Invalidate();
            base.OnMouseDown(e);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            pressing = false;
            Invalidate();
            base.OnMouseUp(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            var rect = new Rectangle(0, 0, Width - 1, Height - 1);
            var fill = Color.Transparent;
            if (hovering)
                fill = kind == CaptionButtonKind.Close ? Color.FromArgb(255, 235, 238) : Theme.Surface3;
            if (pressing)
                fill = kind == CaptionButtonKind.Close ? Color.FromArgb(252, 213, 220) : Theme.AccentDim;
            using (var path = Theme.Round(rect, 12))
            using (var brush = new SolidBrush(fill))
            {
                e.Graphics.FillPath(brush, path);
            }

            var stroke = kind == CaptionButtonKind.Close && hovering ? Theme.Danger : Theme.Muted;
            using (var pen = new Pen(stroke, 1.8f))
            {
                pen.StartCap = LineCap.Round;
                pen.EndCap = LineCap.Round;
                if (kind == CaptionButtonKind.Minimize)
                {
                    e.Graphics.DrawLine(pen, 12, 20, 24, 20);
                }
                else if (kind == CaptionButtonKind.Maximize)
                {
                    e.Graphics.DrawRectangle(pen, 12, 11, 12, 10);
                }
                else
                {
                    e.Graphics.DrawLine(pen, 13, 12, 23, 22);
                    e.Graphics.DrawLine(pen, 23, 12, 13, 22);
                }
            }
        }
    }

    internal sealed class ToggleSwitch : Control
    {
        private bool isOn;
        public event EventHandler Toggled;

        public bool IsOn
        {
            get { return isOn; }
            set
            {
                if (isOn == value) return;
                isOn = value;
                Invalidate();
                if (Toggled != null) Toggled(this, EventArgs.Empty);
            }
        }

        public ToggleSwitch()
        {
            Width = 62;
            Height = 32;
            Cursor = Cursors.Hand;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
        }

        protected override void OnClick(EventArgs e)
        {
            base.OnClick(e);
            IsOn = !IsOn;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            var track = new Rectangle(1, 1, Width - 3, Height - 3);
            using (var path = Theme.Round(track, Height / 2))
            using (var brush = new SolidBrush(IsOn ? Theme.Accent : Theme.Surface3))
            using (var pen = new Pen(IsOn ? Theme.Accent : Theme.Border, 1))
            {
                e.Graphics.FillPath(brush, path);
                e.Graphics.DrawPath(pen, path);
            }
            int knob = Height - 10;
            int x = IsOn ? Width - knob - 6 : 6;
            var knobRect = new Rectangle(x, 5, knob, knob);
            using (var brush = new SolidBrush(IsOn ? Theme.Background : Color.FromArgb(230, 238, 245, 242)))
            {
                e.Graphics.FillEllipse(brush, knobRect);
            }
        }
    }

    internal static class Theme
    {
        public static readonly Color Background = Color.FromArgb(246, 250, 247);
        public static readonly Color Surface = Color.FromArgb(255, 253, 248);
        public static readonly Color Surface2 = Color.FromArgb(239, 248, 244);
        public static readonly Color Surface3 = Color.FromArgb(225, 242, 236);
        public static readonly Color Border = Color.FromArgb(193, 216, 207);
        public static readonly Color BorderSoft = Color.FromArgb(218, 232, 226);
        public static readonly Color Text = Color.FromArgb(30, 45, 43);
        public static readonly Color Muted = Color.FromArgb(93, 111, 107);
        public static readonly Color Accent = Color.FromArgb(38, 164, 120);
        public static readonly Color AccentCyan = Color.FromArgb(71, 157, 185);
        public static readonly Color AccentDim = Color.FromArgb(206, 239, 228);
        public static readonly Color Danger = Color.FromArgb(197, 67, 79);
        public static readonly Color Warning = Color.FromArgb(178, 126, 42);

        public static Font Font(float size, FontStyle style = FontStyle.Regular)
        {
            return new Font("Microsoft YaHei UI", size, style, GraphicsUnit.Point);
        }

        public static GraphicsPath Round(Rectangle rect, int radius)
        {
            var path = new GraphicsPath();
            if (rect.Width <= 0 || rect.Height <= 0)
            {
                path.AddRectangle(Rectangle.Empty);
                return path;
            }
            if (radius <= 0)
            {
                path.AddRectangle(rect);
                return path;
            }
            radius = Math.Min(radius, Math.Min(rect.Width, rect.Height) / 2);
            int d = radius * 2;
            path.AddArc(rect.X, rect.Y, d, d, 180, 90);
            path.AddArc(rect.Right - d, rect.Y, d, d, 270, 90);
            path.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0, 90);
            path.AddArc(rect.X, rect.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }
    }

    internal sealed class SkillHubForm : Form
    {
        private readonly string root;
        private readonly string appRoot;
        private readonly string configPath;
        private readonly string statePath;
        private readonly string reportPath;
        private readonly string skillHubScript;
        private readonly string installTaskScript;
        private readonly string uninstallTaskScript;
        private readonly string skillsPath;
        private readonly string sourcesPath;
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 * 20 };
        private readonly List<CategoryItem> categories = new List<CategoryItem>();

        private string lang = "zh";
        private SkillHubConfig config;
        private List<SkillState> skills = new List<SkillState>();
        private string selectedRepoName;

        private Panel titleBar;
        private PictureBox logoBox;
        private Label appTitle;
        private Label miniStatus;
        private PillButton zhButton;
        private PillButton enButton;
        private PillButton koButton;
        private CaptionButton minButton;
        private CaptionButton maxButton;
        private CaptionButton closeButton;
        private Label activeCount;
        private Label repoCount;
        private Label lastSync;
        private ToggleSwitch autoToggle;
        private ToggleSwitch linksToggle;
        private TextBox urlBox;
        private ComboBox typeBox;
        private ComboBox categoryBox;
        private TextBox noteBox;
        private PillButton addButton;
        private PillButton saveButton;
        private PillButton deleteButton;
        private PillButton syncButton;
        private PillButton reportButton;
        private PillButton skillsButton;
        private PillButton sourcesButton;
        private DataGridView skillsGrid;
        private DataGridView reposGrid;
        private RichTextBox logBox;
        private Label helperLabel;

        [DllImport("user32.dll")]
        private static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam);

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.ClassStyle |= 0x00020000;
                return cp;
            }
        }

        public SkillHubForm()
        {
            root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            appRoot = Path.Combine(root, "app");
            configPath = Path.Combine(appRoot, "skillhub.config.json");
            statePath = Path.Combine(appRoot, ".skillhub", "managed-links.json");
            reportPath = Path.Combine(appRoot, "reports", "last-sync.md");
            skillHubScript = Path.Combine(appRoot, "SkillHub.ps1");
            installTaskScript = Path.Combine(appRoot, "安装每日自动更新任务.ps1");
            uninstallTaskScript = Path.Combine(appRoot, "卸载每日自动更新任务.ps1");
            skillsPath = Path.Combine(root, "skills");
            sourcesPath = Path.Combine(appRoot, "github_sources");

            Text = "AI SkillHub";
            MinimumSize = new Size(1180, 760);
            Size = new Size(1280, 820);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.None;
            BackColor = Theme.Background;
            DoubleBuffered = true;
            Font = Theme.Font(10f);

            LoadIcon();
            BuildCategories();
            BuildUi();
            LoadData();
            ApplyLanguage();
            RefreshAll();
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            if (WindowState == FormWindowState.Maximized || WindowState == FormWindowState.Minimized)
            {
                Region = null;
            }
            else if (Width > 0 && Height > 0)
            {
                using (var path = Theme.Round(new Rectangle(0, 0, Width, Height), 18))
                {
                    Region = new Region(path);
                }
            }
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (var brush = new LinearGradientBrush(ClientRectangle, Color.FromArgb(247, 251, 248), Color.FromArgb(232, 244, 239), 35f))
            {
                e.Graphics.FillRectangle(brush, ClientRectangle);
            }
            if (WindowState != FormWindowState.Maximized)
            {
                using (var pen = new Pen(Theme.Border, 1))
                {
                    e.Graphics.DrawRectangle(pen, 0, 0, Width - 1, Height - 1);
                }
            }
        }

        private void LoadIcon()
        {
            string ico = Path.Combine(appRoot, "assets", "AI SkillHub.ico");
            string png = Path.Combine(appRoot, "assets", "AI SkillHub.logo.png");
            if (File.Exists(ico))
            {
                Icon = new Icon(ico);
            }
            else if (File.Exists(png))
            {
                using (var img = Image.FromFile(png))
                using (var bmp = new Bitmap(img, 64, 64))
                {
                    Icon = Icon.FromHandle(bmp.GetHicon());
                }
            }
        }

        private void BuildCategories()
        {
            categories.Add(new CategoryItem { Id = "auto", Zh = "自动分类", En = "Auto", Ko = "자동" });
            categories.Add(new CategoryItem { Id = "academic-writing", Zh = "论文科研", En = "Academic", Ko = "논문·연구" });
            categories.Add(new CategoryItem { Id = "scientific-figures", Zh = "科研图表", En = "Figures", Ko = "과학 도표" });
            categories.Add(new CategoryItem { Id = "ui-design", Zh = "界面设计", En = "UI Design", Ko = "UI 디자인" });
            categories.Add(new CategoryItem { Id = "literature-research", Zh = "文献研究", En = "Research", Ko = "문헌 연구" });
            categories.Add(new CategoryItem { Id = "presentation", Zh = "学术汇报", En = "Presentation", Ko = "발표" });
            categories.Add(new CategoryItem { Id = "prompt-polishing", Zh = "提示词润色", En = "Prompt", Ko = "프롬프트" });
            categories.Add(new CategoryItem { Id = "security", Zh = "安全审计", En = "Security", Ko = "보안" });
            categories.Add(new CategoryItem { Id = "image-generation", Zh = "图像生成", En = "Image", Ko = "이미지" });
            categories.Add(new CategoryItem { Id = "knowledge-retrieval", Zh = "知识检索", En = "Knowledge", Ko = "지식 검색" });
            categories.Add(new CategoryItem { Id = "general", Zh = "通用工具", En = "General", Ko = "범용" });
        }

        private void BuildUi()
        {
            titleBar = new Panel { Dock = DockStyle.Top, Height = 58, BackColor = Theme.Surface };
            titleBar.Paint += delegate (object sender, PaintEventArgs e)
            {
                using (var pen = new Pen(Theme.BorderSoft, 1))
                    e.Graphics.DrawLine(pen, 0, titleBar.Height - 1, titleBar.Width, titleBar.Height - 1);
            };
            titleBar.MouseDown += DragWindow;
            Controls.Add(titleBar);

            logoBox = new PictureBox { Left = 18, Top = 12, Width = 34, Height = 34, SizeMode = PictureBoxSizeMode.Zoom };
            string logo = Path.Combine(appRoot, "assets", "AI SkillHub.logo.png");
            if (!File.Exists(logo)) logo = Path.Combine(appRoot, "assets", "AI SkillHub.png");
            if (File.Exists(logo)) logoBox.Image = Image.FromFile(logo);
            titleBar.Controls.Add(logoBox);

            appTitle = new Label { Left = 60, Top = 15, Width = 150, Height = 28, ForeColor = Theme.Text, Font = Theme.Font(12.5f, FontStyle.Bold), Text = "AI SkillHub" };
            appTitle.MouseDown += DragWindow;
            titleBar.Controls.Add(appTitle);

            miniStatus = new Label { Left = 202, Top = 17, Width = 96, Height = 24, ForeColor = Theme.Accent, Font = Theme.Font(9.2f, FontStyle.Bold), TextAlign = ContentAlignment.MiddleCenter };
            titleBar.Controls.Add(miniStatus);

            zhButton = TopButton("中文", 0);
            enButton = TopButton("English", 1);
            koButton = TopButton("한국어", 2);
            zhButton.Click += delegate { lang = "zh"; ApplyLanguage(); RefreshAll(); };
            enButton.Click += delegate { lang = "en"; ApplyLanguage(); RefreshAll(); };
            koButton.Click += delegate { lang = "ko"; ApplyLanguage(); RefreshAll(); };

            closeButton = WindowButton(CaptionButtonKind.Close);
            maxButton = WindowButton(CaptionButtonKind.Maximize);
            minButton = WindowButton(CaptionButtonKind.Minimize);
            closeButton.Click += delegate { Close(); };
            maxButton.Click += delegate { WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized; };
            minButton.Click += delegate { WindowState = FormWindowState.Minimized; };

            var main = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(24, 80, 24, 24), ColumnCount = 2, RowCount = 1, BackColor = Color.Transparent };
            main.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 330));
            main.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            Controls.Add(main);

            var side = Card();
            side.Padding = new Padding(20);
            main.Controls.Add(side, 0, 0);

            var title = LabelText("AI SkillHub", 26f, FontStyle.Bold, Theme.Text, 0, 8, 270, 38);
            side.Controls.Add(title);
            var sub = LabelText("", 10.5f, FontStyle.Regular, Theme.Muted, 0, 50, 280, 48);
            sub.Name = "subtitle";
            side.Controls.Add(sub);

            activeCount = Metric(side, 0, 112, "已启用", "0");
            repoCount = Metric(side, 156, 112, "仓库", "0");
            lastSync = LabelText("", 9.2f, FontStyle.Regular, Theme.Muted, 0, 208, 286, 48);
            side.Controls.Add(lastSync);

            side.Controls.Add(LabelText("每日自动更新", 10f, FontStyle.Bold, Theme.Text, 0, 274, 190, 24));
            autoToggle = new ToggleSwitch { Left = 225, Top = 270 };
            autoToggle.Toggled += AutoToggleHandler;
            side.Controls.Add(autoToggle);

            side.Controls.Add(LabelText("接管 AI 软件链接", 10f, FontStyle.Bold, Theme.Text, 0, 326, 190, 24));
            linksToggle = new ToggleSwitch { Left = 225, Top = 322 };
            linksToggle.Toggled += LinksToggleHandler;
            side.Controls.Add(linksToggle);

            syncButton = Button("立即同步", 0, 386, 286, true);
            syncButton.Click += delegate { RunSync(false); };
            side.Controls.Add(syncButton);
            reportButton = Button("打开报告", 0, 438, 286, false);
            reportButton.Click += delegate { OpenPath(reportPath); };
            side.Controls.Add(reportButton);
            skillsButton = Button("打开技能目录", 0, 490, 286, false);
            skillsButton.Click += delegate { OpenPath(skillsPath); };
            side.Controls.Add(skillsButton);
            sourcesButton = Button("打开来源目录", 0, 542, 286, false);
            sourcesButton.Click += delegate { OpenPath(sourcesPath); };
            side.Controls.Add(sourcesButton);

            helperLabel = LabelText("", 9.3f, FontStyle.Regular, Theme.Muted, 0, 610, 286, 72);
            side.Controls.Add(helperLabel);

            var content = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 3, BackColor = Color.Transparent };
            content.RowStyles.Add(new RowStyle(SizeType.Absolute, 196));
            content.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            content.RowStyles.Add(new RowStyle(SizeType.Absolute, 164));
            main.Controls.Add(content, 1, 0);

            var editor = Card();
            editor.Padding = new Padding(18);
            content.Controls.Add(editor, 0, 0);

            editor.Controls.Add(LabelText("GitHub 项目地址", 10f, FontStyle.Bold, Theme.Text, 0, 2, 260, 24));
            urlBox = DarkTextBox(0, 32, 470, 42);
            editor.Controls.Add(urlBox);

            editor.Controls.Add(LabelText("类型", 10f, FontStyle.Bold, Theme.Text, 490, 2, 120, 24));
            typeBox = DarkCombo(490, 32, 130, 42);
            editor.Controls.Add(typeBox);

            editor.Controls.Add(LabelText("细分分类", 10f, FontStyle.Bold, Theme.Text, 635, 2, 120, 24));
            categoryBox = DarkCombo(635, 32, 130, 42);
            editor.Controls.Add(categoryBox);

            addButton = Button("添加", 780, 31, 104, true);
            addButton.Click += delegate { AddRepository(); };
            editor.Controls.Add(addButton);

            editor.Controls.Add(LabelText("手动备注", 10f, FontStyle.Bold, Theme.Text, 0, 94, 160, 24));
            noteBox = DarkTextBox(0, 124, 520, 42);
            editor.Controls.Add(noteBox);
            saveButton = Button("保存修改", 540, 123, 126, false);
            saveButton.Click += delegate { SaveSelectedRepository(); };
            editor.Controls.Add(saveButton);
            deleteButton = Button("删除来源", 682, 123, 126, false);
            deleteButton.Fill = Color.FromArgb(255, 239, 241);
            deleteButton.Border = Color.FromArgb(232, 176, 184);
            deleteButton.TextColor = Theme.Danger;
            deleteButton.Click += delegate { DeleteSelectedRepository(); };
            editor.Controls.Add(deleteButton);

            var grids = new TabControl { Dock = DockStyle.Fill, Font = Theme.Font(10f), BackColor = Theme.Background };
            content.Controls.Add(grids, 0, 1);
            var skillsTab = new TabPage("已启用技能") { BackColor = Theme.Background };
            var reposTab = new TabPage("仓库来源") { BackColor = Theme.Background };
            grids.TabPages.Add(skillsTab);
            grids.TabPages.Add(reposTab);

            skillsGrid = Grid();
            skillsGrid.Columns.Add("Skill", "技能");
            skillsGrid.Columns.Add("Category", "分类");
            skillsGrid.Columns.Add("Repo", "仓库");
            skillsGrid.Columns.Add("Note", "备注");
            skillsGrid.Columns.Add("Target", "来源位置");
            skillsGrid.Columns[0].Width = 180;
            skillsGrid.Columns[1].Width = 130;
            skillsGrid.Columns[2].Width = 180;
            skillsGrid.Columns[3].Width = 220;
            skillsGrid.Columns[4].AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill;
            skillsTab.Controls.Add(skillsGrid);

            reposGrid = Grid();
            reposGrid.Columns.Add("Name", "名称");
            reposGrid.Columns.Add("Type", "类型");
            reposGrid.Columns.Add("Category", "分类");
            reposGrid.Columns.Add("Mode", "模式");
            reposGrid.Columns.Add("Note", "备注");
            reposGrid.Columns.Add("Url", "地址");
            reposGrid.Columns[0].Width = 190;
            reposGrid.Columns[1].Width = 110;
            reposGrid.Columns[2].Width = 130;
            reposGrid.Columns[3].Width = 120;
            reposGrid.Columns[4].Width = 260;
            reposGrid.Columns[5].AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill;
            reposGrid.SelectionChanged += delegate { LoadSelectedRepository(); };
            reposTab.Controls.Add(reposGrid);

            var logPanel = Card();
            logPanel.Padding = new Padding(14);
            content.Controls.Add(logPanel, 0, 2);
            var logTitle = LabelText("运行反馈", 10f, FontStyle.Bold, Theme.Text, 0, 0, 140, 24);
            logPanel.Controls.Add(logTitle);
            logBox = new RichTextBox
            {
                Left = 0,
                Top = 30,
                Width = 760,
                Height = 100,
                Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right,
                BackColor = Color.FromArgb(252, 255, 252),
                ForeColor = Theme.Text,
                BorderStyle = BorderStyle.None,
                Font = Theme.Font(10f),
                ReadOnly = true,
                DetectUrls = false
            };
            logPanel.Controls.Add(logBox);

            Resize += delegate
            {
                PositionTitleControls();
            };
            titleBar.Resize += delegate { PositionTitleControls(); };
            titleBar.BringToFront();
            PositionTitleControls();
        }

        private void PositionTitleControls()
        {
            if (titleBar == null || zhButton == null) return;
            int right = Math.Max(320, titleBar.Width - 398);
            zhButton.Left = right;
            enButton.Left = right + 72;
            koButton.Left = right + 158;
            minButton.Left = titleBar.Width - 126;
            maxButton.Left = titleBar.Width - 84;
            closeButton.Left = titleBar.Width - 42;
        }

        private Panel Card()
        {
            var p = new Panel { Dock = DockStyle.Fill, BackColor = Color.Transparent, Margin = new Padding(0, 0, 0, 0) };
            p.Paint += delegate (object sender, PaintEventArgs e)
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                var r = new Rectangle(0, 0, p.Width - 1, p.Height - 1);
                using (var path = Theme.Round(r, 22))
                using (var brush = new SolidBrush(Theme.Surface))
                using (var pen = new Pen(Theme.BorderSoft, 1))
                {
                    e.Graphics.FillPath(brush, path);
                    e.Graphics.DrawPath(pen, path);
                }
            };
            return p;
        }

        private PillButton TopButton(string text, int index)
        {
            var b = new PillButton { Text = text, Top = 13, Width = index == 1 ? 84 : 70, Height = 32, Radius = 15, Fill = Theme.Surface2, HoverFill = Theme.Surface3, Border = Theme.BorderSoft };
            titleBar.Controls.Add(b);
            return b;
        }

        private CaptionButton WindowButton(CaptionButtonKind kind)
        {
            var b = new CaptionButton(kind) { Top = 13, Width = 36, Height = 32 };
            titleBar.Controls.Add(b);
            return b;
        }

        private Label LabelText(string text, float size, FontStyle style, Color color, int x, int y, int w, int h)
        {
            return new Label { Text = text, Left = x, Top = y, Width = w, Height = h, ForeColor = color, Font = Theme.Font(size, style), BackColor = Color.Transparent };
        }

        private Label Metric(Control parent, int x, int y, string label, string value)
        {
            var box = new Panel { Left = x, Top = y, Width = 132, Height = 76, BackColor = Color.Transparent };
            box.Paint += delegate (object sender, PaintEventArgs e)
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                using (var path = Theme.Round(new Rectangle(0, 0, box.Width - 1, box.Height - 1), 18))
                using (var brush = new SolidBrush(Theme.Surface2))
                using (var pen = new Pen(Theme.BorderSoft))
                {
                    e.Graphics.FillPath(brush, path);
                    e.Graphics.DrawPath(pen, path);
                }
            };
            box.Controls.Add(LabelText(label, 9f, FontStyle.Regular, Theme.Muted, 12, 10, 100, 18));
            var valueLabel = LabelText(value, 24f, FontStyle.Bold, Theme.Text, 12, 30, 100, 36);
            box.Controls.Add(valueLabel);
            parent.Controls.Add(box);
            return valueLabel;
        }

        private TextBox DarkTextBox(int x, int y, int w, int h)
        {
            return new TextBox
            {
                Left = x,
                Top = y,
                Width = w,
                Height = h,
                BorderStyle = BorderStyle.FixedSingle,
                BackColor = Color.FromArgb(252, 255, 252),
                ForeColor = Theme.Text,
                Font = Theme.Font(10.5f),
                Margin = new Padding(0)
            };
        }

        private ComboBox DarkCombo(int x, int y, int w, int h)
        {
            return new ComboBox
            {
                Left = x,
                Top = y,
                Width = w,
                Height = h,
                DropDownStyle = ComboBoxStyle.DropDownList,
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(252, 255, 252),
                ForeColor = Theme.Text,
                Font = Theme.Font(10.5f)
            };
        }

        private PillButton Button(string text, int x, int y, int w, bool primary)
        {
            return new PillButton
            {
                Text = text,
                Left = x,
                Top = y,
                Width = w,
                Height = 42,
                Fill = primary ? Theme.Accent : Theme.Surface2,
                HoverFill = primary ? Color.FromArgb(56, 184, 138) : Theme.Surface3,
                Border = primary ? Theme.Accent : Theme.Border,
                TextColor = primary ? Color.FromArgb(246, 255, 250) : Theme.Text
            };
        }

        private DataGridView Grid()
        {
            var g = new DataGridView
            {
                Dock = DockStyle.Fill,
                BackgroundColor = Theme.Surface,
                BorderStyle = BorderStyle.None,
                AllowUserToAddRows = false,
                AllowUserToDeleteRows = false,
                AllowUserToResizeRows = false,
                ReadOnly = true,
                SelectionMode = DataGridViewSelectionMode.FullRowSelect,
                MultiSelect = false,
                RowHeadersVisible = false,
                EnableHeadersVisualStyles = false,
                Font = Theme.Font(9.5f),
                ColumnHeadersHeight = 38,
                RowTemplate = { Height = 34 }
            };
            g.ColumnHeadersDefaultCellStyle.BackColor = Theme.Surface2;
            g.ColumnHeadersDefaultCellStyle.ForeColor = Theme.Text;
            g.ColumnHeadersDefaultCellStyle.SelectionBackColor = Theme.Surface2;
            g.DefaultCellStyle.BackColor = Theme.Surface;
            g.DefaultCellStyle.ForeColor = Theme.Text;
            g.DefaultCellStyle.SelectionBackColor = Theme.AccentDim;
            g.DefaultCellStyle.SelectionForeColor = Theme.Text;
            g.GridColor = Theme.BorderSoft;
            return g;
        }

        private void DragWindow(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            ReleaseCapture();
            SendMessage(Handle, 0xA1, 0x2, 0);
        }

        private string T(string key)
        {
            var zh = new Dictionary<string, string> {
                {"subtitle","管理 GitHub Skills、Prompt 来源、AI 软件链接和每日自动更新。"},
                {"ready","就绪"}, {"running","正在运行"}, {"sync","立即同步"}, {"report","打开报告"}, {"skills","打开技能目录"}, {"sources","打开来源目录"},
                {"helper","提示：选择仓库来源中的一行，就可以修改类型、分类和手动备注。若类型是 Prompt，它不会出现在已启用技能。"},
                {"active","已启用"}, {"repo","仓库"}, {"last","最近同步"}, {"add","添加"}, {"save","保存修改"}, {"delete","删除来源"}
            };
            var en = new Dictionary<string, string> {
                {"subtitle","Manage GitHub Skills, prompt sources, AI app links, and daily updates."},
                {"ready","Ready"}, {"running","Running"}, {"sync","Sync Now"}, {"report","Open Report"}, {"skills","Open Skills"}, {"sources","Open Sources"},
                {"helper","Tip: select a repository row to edit type, category, and note. Prompt sources are not installed as active skills."},
                {"active","Active"}, {"repo","Repos"}, {"last","Last sync"}, {"add","Add"}, {"save","Save Changes"}, {"delete","Remove Source"}
            };
            var ko = new Dictionary<string, string> {
                {"subtitle","GitHub Skill, 프롬프트 소스, AI 앱 링크, 매일 업데이트를 관리합니다."},
                {"ready","준비됨"}, {"running","실행 중"}, {"sync","지금 동기화"}, {"report","보고서 열기"}, {"skills","Skill 폴더"}, {"sources","소스 폴더"},
                {"helper","팁: 저장소 행을 선택하면 유형, 분류, 메모를 수정할 수 있습니다. Prompt는 활성 Skill에 설치되지 않습니다."},
                {"active","활성"}, {"repo","저장소"}, {"last","최근 동기화"}, {"add","추가"}, {"save","변경 저장"}, {"delete","소스 삭제"}
            };
            var dict = lang == "en" ? en : lang == "ko" ? ko : zh;
            return dict.ContainsKey(key) ? dict[key] : key;
        }

        private void ApplyLanguage()
        {
            ((Label)Controls.Find("subtitle", true).First()).Text = T("subtitle");
            miniStatus.Text = T("ready");
            syncButton.Text = T("sync");
            reportButton.Text = T("report");
            skillsButton.Text = T("skills");
            sourcesButton.Text = T("sources");
            helperLabel.Text = T("helper");
            addButton.Text = T("add");
            saveButton.Text = T("save");
            deleteButton.Text = T("delete");

            zhButton.Fill = lang == "zh" ? Theme.Accent : Theme.Surface2;
            enButton.Fill = lang == "en" ? Theme.Accent : Theme.Surface2;
            koButton.Fill = lang == "ko" ? Theme.Accent : Theme.Surface2;
            zhButton.TextColor = lang == "zh" ? Color.FromArgb(246, 255, 250) : Theme.Text;
            enButton.TextColor = lang == "en" ? Color.FromArgb(246, 255, 250) : Theme.Text;
            koButton.TextColor = lang == "ko" ? Color.FromArgb(246, 255, 250) : Theme.Text;
            zhButton.Invalidate();
            enButton.Invalidate();
            koButton.Invalidate();

            typeBox.Items.Clear();
            typeBox.Items.Add(lang == "en" ? "Skill" : lang == "ko" ? "Skill" : "技能");
            typeBox.Items.Add(lang == "en" ? "Prompt" : lang == "ko" ? "Prompt" : "润色 Prompt");
            if (typeBox.SelectedIndex < 0) typeBox.SelectedIndex = 0;

            categoryBox.Items.Clear();
            foreach (var item in categories) categoryBox.Items.Add(item.Label(lang));
            if (categoryBox.SelectedIndex < 0) categoryBox.SelectedIndex = 0;
        }

        private void LoadData()
        {
            if (File.Exists(configPath))
                config = json.Deserialize<SkillHubConfig>(File.ReadAllText(configPath, Encoding.UTF8));
            if (config == null) config = new SkillHubConfig();
            if (config.repositories == null) config.repositories = new List<RepositoryConfig>();
            if (config.preferredPathFragments == null) config.preferredPathFragments = new List<string>();

            if (File.Exists(statePath))
                skills = json.Deserialize<List<SkillState>>(File.ReadAllText(statePath, Encoding.UTF8)) ?? new List<SkillState>();
        }

        private void SaveConfig()
        {
            File.WriteAllText(configPath, json.Serialize(config), new UTF8Encoding(true));
        }

        private void RefreshAll()
        {
            LoadData();
            RefreshMetrics();
            RefreshRepos();
            RefreshSkills();
        }

        private void RefreshMetrics()
        {
            activeCount.Text = skills.Count.ToString();
            repoCount.Text = config.repositories.Count.ToString();
            lastSync.Text = T("last") + ": " + (File.Exists(reportPath) ? File.GetLastWriteTime(reportPath).ToString("yyyy-MM-dd HH:mm:ss") : "未确认");
            bool task = TestDailyTask();
            autoToggle.Toggled -= AutoToggleHandler;
            autoToggle.IsOn = task;
            autoToggle.Toggled += AutoToggleHandler;
            linksToggle.Toggled -= LinksToggleHandler;
            linksToggle.IsOn = config.manageAgentLinks;
            linksToggle.Toggled += LinksToggleHandler;
        }

        private void RefreshRepos()
        {
            reposGrid.Rows.Clear();
            foreach (var repo in config.repositories.OrderBy(r => r.name))
            {
                string category = CategoryLabel(string.IsNullOrWhiteSpace(repo.categoryId) ? "auto" : repo.categoryId);
                reposGrid.Rows.Add(repo.name, repo.type == "prompt" ? "Prompt" : "Skill", category, repo.mode, repo.note ?? "", repo.url);
            }
        }

        private void RefreshSkills()
        {
            skillsGrid.Rows.Clear();
            foreach (var skill in skills.OrderBy(s => s.Skill))
            {
                skillsGrid.Rows.Add(skill.Skill, CategoryLabel(skill.CategoryId), skill.Repo, skill.Note ?? "", skill.Target);
            }
        }

        private string CategoryLabel(string id)
        {
            var item = categories.FirstOrDefault(c => c.Id == id);
            return item == null ? id : item.Label(lang);
        }

        private string SelectedCategoryId()
        {
            int index = categoryBox.SelectedIndex;
            if (index < 0 || index >= categories.Count) return "auto";
            return categories[index].Id;
        }

        private string RepoNameFromUrl(string url)
        {
            string clean = NormalizeGithubUrl(url);
            string name = clean.Substring(clean.LastIndexOf('/') + 1);
            if (name.EndsWith(".git", StringComparison.OrdinalIgnoreCase))
                name = name.Substring(0, name.Length - 4);
            return name;
        }

        private bool IsSafeGithubUrl(string url)
        {
            string clean = NormalizeGithubUrl(url);
            return System.Text.RegularExpressions.Regex.IsMatch(clean, @"^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?$");
        }

        private string NormalizeGithubUrl(string url)
        {
            if (String.IsNullOrWhiteSpace(url)) return "";
            string clean = url.Trim();
            clean = System.Text.RegularExpressions.Regex.Replace(clean, @"^https\s*:\s*/\s*/\s*", "https://", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            clean = System.Text.RegularExpressions.Regex.Replace(clean, @"\s+", "");
            return clean.TrimEnd('/');
        }

        private void AddRepository()
        {
            string url = NormalizeGithubUrl(urlBox.Text);
            if (!IsSafeGithubUrl(url))
            {
                MessageBox.Show("GitHub 地址格式不正确，请使用：https://github.com/作者/仓库.git", "AI SkillHub", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            string name = RepoNameFromUrl(url);
            if (config.repositories.Any(r => r.name == name || r.url == url))
            {
                MessageBox.Show("这个仓库已经存在。", "AI SkillHub", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            bool prompt = typeBox.SelectedIndex == 1;
            config.repositories.Add(new RepositoryConfig
            {
                name = name,
                url = url,
                type = prompt ? "prompt" : "skills",
                mode = prompt ? "do-not-install" : "scan",
                categoryId = SelectedCategoryId() == "auto" && prompt ? "prompt-polishing" : (SelectedCategoryId() == "auto" ? null : SelectedCategoryId()),
                note = noteBox.Text.Trim()
            });
            SaveConfig();
            AppendLog("已添加：" + name);
            RunSync(false);
        }

        private void LoadSelectedRepository()
        {
            if (reposGrid.SelectedRows.Count == 0) return;
            selectedRepoName = Convert.ToString(reposGrid.SelectedRows[0].Cells[0].Value);
            var repo = config.repositories.FirstOrDefault(r => r.name == selectedRepoName);
            if (repo == null) return;
            urlBox.Text = repo.url;
            typeBox.SelectedIndex = repo.type == "prompt" ? 1 : 0;
            string category = string.IsNullOrWhiteSpace(repo.categoryId) ? "auto" : repo.categoryId;
            int index = categories.FindIndex(c => c.Id == category);
            categoryBox.SelectedIndex = index < 0 ? 0 : index;
            noteBox.Text = repo.note ?? "";
        }

        private void SaveSelectedRepository()
        {
            if (string.IsNullOrWhiteSpace(selectedRepoName))
            {
                MessageBox.Show("请先在“仓库来源”里选中一行。", "AI SkillHub", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            var repo = config.repositories.FirstOrDefault(r => r.name == selectedRepoName);
            if (repo == null) return;
            bool prompt = typeBox.SelectedIndex == 1;
            repo.type = prompt ? "prompt" : "skills";
            repo.mode = prompt ? "do-not-install" : "scan";
            repo.categoryId = SelectedCategoryId() == "auto" ? null : SelectedCategoryId();
            if (prompt && string.IsNullOrWhiteSpace(repo.categoryId)) repo.categoryId = "prompt-polishing";
            repo.note = noteBox.Text.Trim();
            SaveConfig();
            AppendLog("已保存修改：" + repo.name);
            RunSync(false);
        }

        private void DeleteSelectedRepository()
        {
            if (string.IsNullOrWhiteSpace(selectedRepoName)) return;
            var repo = config.repositories.FirstOrDefault(r => r.name == selectedRepoName);
            if (repo == null) return;
            if (MessageBox.Show("确定从配置里删除这个来源吗？不会删除 GitHub 源码文件夹。", "AI SkillHub", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes)
                return;
            config.repositories.Remove(repo);
            SaveConfig();
            selectedRepoName = null;
            urlBox.Clear();
            noteBox.Clear();
            RunSync(false);
        }

        private void ToggleAutoTask()
        {
            ToggleAutoTaskCore(autoToggle.IsOn);
        }

        private void AutoToggleHandler(object sender, EventArgs e) { ToggleAutoTask(); }
        private void LinksToggleHandler(object sender, EventArgs e) { ToggleManageLinks(); }

        private void ToggleAutoTaskCore(bool enabled)
        {
            string script = enabled ? installTaskScript : uninstallTaskScript;
            RunScript(script, null);
        }

        private void ToggleManageLinks()
        {
            config.manageAgentLinks = linksToggle.IsOn;
            SaveConfig();
            if (linksToggle.IsOn) RunScript(Path.Combine(appRoot, "Manage-AgentSkillLinks.ps1"), null);
        }

        private void RunSync(bool pull)
        {
            RunScript(skillHubScript, pull ? "" : "-NoPull");
        }

        private void RunScript(string script, string extraArgs)
        {
            string fullScript = Path.GetFullPath(script);
            if (!fullScript.StartsWith(Path.GetFullPath(appRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            {
                AppendLog("Refused to run script outside app package: " + fullScript);
                return;
            }
            SetBusy(true);
            AppendLog("开始运行：" + Path.GetFileName(script));
            ThreadPool.QueueUserWorkItem(delegate
            {
                int exitCode = -1;
                try
                {
                    var psi = new ProcessStartInfo
                    {
                        FileName = PowerShellPath(),
                        Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + fullScript + "\"" + (string.IsNullOrWhiteSpace(extraArgs) ? "" : " " + extraArgs),
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        StandardOutputEncoding = Encoding.UTF8,
                        StandardErrorEncoding = Encoding.UTF8,
                        WorkingDirectory = appRoot
                    };
                    using (var p = new Process { StartInfo = psi })
                    {
                        p.OutputDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) AppendLog(e.Data); };
                        p.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) AppendLog(e.Data); };
                        p.Start();
                        p.BeginOutputReadLine();
                        p.BeginErrorReadLine();
                        p.WaitForExit();
                        exitCode = p.ExitCode;
                    }
                }
                catch (Exception ex)
                {
                    AppendLog(ex.Message);
                }
                BeginInvoke((Action)delegate
                {
                    SetBusy(false);
                    RefreshAll();
                    miniStatus.Text = exitCode == 0 ? "完成" : "失败";
                });
            });
        }

        private void AppendLog(string text)
        {
            if (InvokeRequired)
            {
                BeginInvoke((Action<string>)AppendLog, text);
                return;
            }
            logBox.AppendText("[" + DateTime.Now.ToString("HH:mm:ss") + "] " + text + Environment.NewLine);
            logBox.ScrollToCaret();
        }

        private void SetBusy(bool busy)
        {
            syncButton.Enabled = !busy;
            addButton.Enabled = !busy;
            saveButton.Enabled = !busy;
            deleteButton.Enabled = !busy;
            miniStatus.Text = busy ? T("running") : T("ready");
            Cursor = busy ? Cursors.WaitCursor : Cursors.Default;
        }

        private bool TestDailyTask()
        {
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "schtasks.exe"),
                    Arguments = "/Query /TN AISkillHubDailyUpdate /FO LIST",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                using (var p = Process.Start(psi))
                {
                    p.WaitForExit();
                    return p.ExitCode == 0;
                }
            }
            catch { return false; }
        }

        private void OpenPath(string path)
        {
            if (File.Exists(path) || Directory.Exists(path))
                Process.Start(new ProcessStartInfo { FileName = path, UseShellExecute = true });
        }

        private string PowerShellPath()
        {
            string windir = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            string path = Path.Combine(windir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
            return File.Exists(path) ? path : "powershell.exe";
        }
    }
}

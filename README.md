# AI SkillHub

AI SkillHub 是一个面向 Windows 的 AI Agent Skills 管理器。它把来自 GitHub、本地文件夹或 zip 压缩包的 Skills/Prompt 资料集中管理，并把可用的 Skill 接管到 Claude Code、Codex、Antigravity 等工具能识别的位置。

这个公开仓库只包含 AI SkillHub 程序本身，不包含 FrancisZhu 的个人 skills、GitHub 来源仓库、诊断报告、缓存或本机配置。

## 核心能力

- 集中管理 GitHub Skills 仓库、本地 Skill 文件夹和 zip 导入来源。
- 自动识别真正的 Skill：只有包含 `SKILL.md` 的目录才会安装为 Skill。
- 区分 Skill 与 Prompt/参考资料，避免把普通提示词资料误装成 Skill。
- 支持 Claude Code、Codex、Antigravity 的 skills 目录接管；没有安装的工具会自动跳过，不创建假目录。
- 支持每日自动同步、立即同步、来源启用/停用、分类、标签、备注、重复技能提示和操作历史。
- 内置系统体检、分享前检查、诊断包导出和 zip 安全预览测试。
- UI 支持中文、English、한국어，包含浅色/可爱/深色主题。

## 快速开始

1. 下载或克隆本仓库。
2. 双击运行 `AI SkillHub.exe`。
3. 第一次启动时，程序会自动创建空白个人配置：`app/skillhub.config.json`。
4. 在软件里粘贴 GitHub 仓库地址，或导入本地文件夹/zip。
5. 点击“立即同步”，软件会把识别到的 Skill 链接到根目录 `skills` 文件夹。
6. 打开“接管 AI 软件链接”后，Claude Code、Codex、Antigravity 会读取这套共享 skills。

公开仓库默认不会带任何第三方 Skill。每个人应在自己的电脑上添加自己的 GitHub 来源。

## 推荐目录结构

```text
AI_global_skills/
  AI SkillHub.exe
  README.md
  使用说明.md
  skills/                    # 本机生成，不提交到 GitHub
  app/
    assets/
    runtime/
    src/
    ui/
    SkillHub.ps1
    Manage-AgentSkillLinks.ps1
    Export-SkillHubDiagnostics.ps1
    skillhub.config.example.json
    skillhub.config.json       # 本机生成，不提交到 GitHub
    github_sources/            # 本机克隆，不提交到 GitHub
    reports/                   # 本机诊断，不提交到 GitHub
```

## 安装要求

- Windows 10/11。
- Git for Windows：用于克隆和更新 GitHub 来源。
- Microsoft Edge WebView2 Runtime：用于显示界面。大多数 Windows 11 电脑已经自带。

普通使用不强制需要 Node、Python、Rust 或 Visual Studio。后续参与 v2/Tauri 开发时才需要这些开发工具。

## 隐私与发布边界

这些内容被 `.gitignore` 明确排除，不会进入公开仓库：

- `skills/`
- `app/github_sources/`
- `app/skillhub.config.json`
- `app/reports/`
- `app/.skillhub/`
- `app/webview2-data/`
- `app/archives/`
- `app/packages/`
- `其它人的优秀项目案例/`

如果你要发布自己的版本，请先运行：

```powershell
git status --short
```

确认没有把个人 Skill、诊断包、本机路径或私有配置放进暂存区。

## 开发技术栈

当前 v1 版本：

- C# WinForms 外壳
- Microsoft WebView2
- 静态 HTML/CSS/JavaScript UI
- PowerShell 同步与链接脚本
- JSON 配置

长期 v2 方向：

- Tauri 2
- React
- TypeScript
- Vite
- Rust 后端
- SQLite

v1 会保持可用；v2 会在稳定后再逐步替换底层。

## 常见问题

### 为什么下载后没有任何 Skill？

因为公开仓库不会附带个人 skills。你需要在软件里添加 GitHub Skill 仓库，或者导入本地 Skill/zip。

### 对方电脑没有 Codex 会报错吗？

不会。AI SkillHub 会检测 Codex 是否真的安装。没有安装时会显示为可忽略信息，不会创建假的 Codex 目录，也不会影响 Claude Code 使用。

### Prompt 仓库为什么不出现在已启用技能里？

Prompt/润色资料不是 Skill。AI SkillHub 会把它作为资料来源保存，但不会安装到 `skills/`，避免 AI 工具把普通文档当成可调用技能。

### zip 导入安全吗？

软件会先预览 zip，并验证解压路径不会逃出目标目录。带 `../` 这类危险路径的 zip 会被拒绝。

## 项目状态

当前公开准备版本：`v1.1.0`。

已通过的关键检查包括：

- `app/ui/app.js` 语法检查
- `AI SkillHub.exe --self-test`
- `AI SkillHub.exe --zip-preview-test`
- 分享前检查：模拟只有 Claude、没有 Codex 的电脑

## 作者

Developed by FrancisZhu.

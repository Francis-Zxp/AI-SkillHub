# Skills 共享与管理说明

## 1. 当前共享目录

现在 Claude Code、Codex、Antigravity 的 Skills 都绑定到了这个共享文件夹：

```text
D:\My Files\AI_global_skills\skills
```

以后真正想让智能体调用的 Skill，就放进这个文件夹。

## 2. 怎样判断一个文件夹是不是 Skill

网上从 GitHub 下载的 zip 压缩包，解压后最外层通常只是仓库文件夹，不一定就是 Skill。

判断方法很简单：

```text
打开一个文件夹
↓
如果它里面直接有 SKILL.md
↓
这个文件夹才是一个 Skill
↓
复制整个这个文件夹到 D:\My Files\AI_global_skills\skills
```

正确结构示例：

```text
D:\My Files\AI_global_skills\skills\paper-workflow\SKILL.md
D:\My Files\AI_global_skills\skills\figure-planner\SKILL.md
D:\My Files\AI_global_skills\skills\nature-polishing\SKILL.md
```

不推荐的结构：

```text
D:\My Files\AI_global_skills\skills\某个GitHub仓库-main\README.md
D:\My Files\AI_global_skills\skills\某个GitHub仓库-main\images
```

如果最外层只有 `README.md`、图片、说明文档，通常说明它只是仓库外壳或普通 prompt 资料，不是可直接调用的 Skill。

## 3. 复制时要复制整个 Skill 文件夹

不要只复制 `SKILL.md`。

应该复制整个包含 `SKILL.md` 的文件夹，因为有些 Skill 还会带：

```text
scripts
reference
assets
templates
```

这些配套文件可能会被 Skill 调用。

## 4. Skill 不是越多越好

Skill 可以理解成给智能体看的“说明书”或“工作方法”。

Claude Code、Codex、Antigravity 会根据用户请求，以及每个 `SKILL.md` 里的 `name` 和 `description`，判断应该调用哪个 Skill。

有时会主要调用一个 Skill，有时会按流程连续使用多个，例如：

```text
paper-workflow → manuscript-optimizer → figure-planner → citation-verifier
```

但是如果同类 Skill 装得太多，例如很多个“论文润色”、很多个“科研绘图”，它们的描述又很接近，智能体可能会选择不稳定，甚至今天用 A，明天用 B。

因此建议：

```text
激活目录里保留少量高质量、用途清楚、不互相打架的 Skill
```

## 5. 推荐的管理结构

建议把共享文件夹整理成这样：

```text
D:\My Files\AI_global_skills
├─ skills
│  └─ 正在启用的 Skill
├─ skills_候选区
│  └─ 下载后先放这里测试
├─ skills_不用但保留
│  └─ 暂时不用、但以后可能会用的 Skill
├─ claude_skills_备份
├─ codex_skills_备份
└─ 其它 GitHub 解压包或 prompt 资料
```

真正会被智能体调用的是：

```text
D:\My Files\AI_global_skills\skills
```

候选区、备份区、普通 prompt 资料一般不会被直接调用。

## 6. 怎样判断哪个作者的 Skill 更好用

不要只看名字，也不要一次性装很多同类 Skill 长期使用。

更好的办法是用同一份任务做对比测试。

### 论文写作类 Skill 测试

可以拿同一段论文内容，让不同 Skill 分别处理：

```text
请优化这段 SCI 论文 Results，使逻辑更像 Nature/Science 风格，但不要夸大结论。
```

比较时看：

```text
1. 是否保留原意，没有乱编结果
2. 是否让逻辑更清楚
3. 是否符合学术语气
4. 是否能指出结构问题，而不是只润色句子
5. 是否给出可执行修改建议
```

### 科研绘图类 Skill 测试

可以让不同 Skill 分别评价同一张图或同一组图表规划。

比较时看：

```text
1. 是否先理解图的科学目的
2. 是否能规划 panel 之间的逻辑
3. 是否能提醒统计标注、图例、坐标轴、显著性说明
4. 是否符合期刊图表风格
5. 是否给出具体可操作的改图建议
```

## 7. 当前建议保留的方向

写论文主流程：

```text
Nature-Paper-Skills 那套主流程 Skill
```

科研图表：

```text
scientific-figure-making
figure-planner
nature-figure
```

前端或 UI 设计：

```text
impeccable
```

普通润色 prompt：

```text
建议单独放在 prompt 资料文件夹，或先放到 skills_候选区，不要直接塞进 skills 激活目录。
```

## 8. 最重要的一句话

不是装得越多越强。

真正好用的方式是：

```text
把真正有 SKILL.md 的 Skill 放进激活目录；
把普通 prompt、GitHub 外壳、候选 Skill 放在旁边；
定期测试同类 Skill，最后只保留最好用、最稳定、最符合自己工作流的版本。
```

## 9. 当前 SkillHub 管理结构

现在已经升级成一个轻量版 SkillHub：

```text
配置文件 + GitHub 源仓库 + active skills 链接 + 同步脚本
```

源仓库放在：

```text
D:\My Files\AI_global_skills\github_sources
```

正在启用的 Skill 入口仍然是：

```text
D:\My Files\AI_global_skills\skills
```

区别是：`skills` 里的 GitHub Skill 现在不再是复制品，而是 Junction 链接，指向 `github_sources` 里的真实目录。

这样做的好处是：

```text
GitHub 作者更新
↓
SkillHub.ps1 执行 git pull 拉取最新
↓
github_sources 里的源码变新
↓
skills 里的链接自动看到最新版
```

也就是说，更新时不需要再手动复制 Skill 文件夹。

## 10. 核心文件说明

```text
D:\My Files\AI_global_skills\skillhub.config.json
```

记录 GitHub 仓库清单、哪些是 Skill、哪些只是 prompt、哪些仓库需要特殊安装规则。

```text
D:\My Files\AI_global_skills\SkillHub.ps1
```

主程序。它负责：

```text
1. 克隆或更新 GitHub 仓库
2. 自动扫描 github_sources 里所有含 SKILL.md 的文件夹
3. 把 Skill 链接到 skills 激活目录
4. 删除以前管理过、但现在不存在的旧链接
5. 生成同步报告
```

```text
D:\My Files\AI_global_skills\更新GitHub来源并同步Skills.ps1
```

给自己日常使用的简短入口，本质上是调用 `SkillHub.ps1`。

```text
D:\My Files\AI_global_skills\SkillHub.UI.ps1
```

图形界面程序。可以添加 GitHub 仓库、手动同步、安装/移除每日自动更新、查看报告和查看当前启用的 Skill。

界面支持中英双语：

```text
默认：根据 Windows 系统语言自动显示
界面右上角：可以切换中文/英文
中文模式：按钮、状态、弹窗、表头尽量只显示中文
```

```text
D:\My Files\AI_global_skills\打开SkillHub界面.cmd
```

双击打开图形界面的入口。

也可以强制打开某一种语言：

```text
D:\My Files\AI_global_skills\打开SkillHub界面_中文.cmd
D:\My Files\AI_global_skills\OpenSkillHubUI_English.cmd
```

```text
D:\My Files\AI_global_skills\安装每日自动更新任务.ps1
```

用于安装 Windows 每日自动更新任务。

```text
D:\My Files\AI_global_skills\卸载每日自动更新任务.ps1
```

用于取消 Windows 每日自动更新任务。

```text
D:\My Files\AI_global_skills\reports\last-sync.md
```

每次同步后的报告，记录当前仓库版本和已启用的 Skill。

## 11. 当前已克隆的 GitHub 来源

Skill 来源：

```text
https://github.com/pbakaus/impeccable.git
https://github.com/Boom5426/Nature-Paper-Skills.git
https://github.com/Yuan1z0825/nature-skills.git
https://github.com/ChenLiu-1996/figures4papers.git
```

普通润色 prompt 来源，不作为 Skill 安装：

```text
https://github.com/Leey21/awesome-ai-research-writing.git
```

这个仓库放在 `github_sources` 里作为资料库保存，但不会链接进 `skills`。

## 12. 如何一键更新到 GitHub 最新版

运行这个脚本：

```text
D:\My Files\AI_global_skills\更新GitHub来源并同步Skills.ps1
```

它会做三件事：

```text
1. 对 github_sources 里的仓库执行 git pull
2. 自动寻找真正含有 SKILL.md 的 Skill 文件夹
3. 检查并修复 skills 里的链接
```

如果你想在 PowerShell 里运行，可以用：

```powershell
powershell -ExecutionPolicy Bypass -File "D:\My Files\AI_global_skills\更新GitHub来源并同步Skills.ps1"
```

运行完成后，重启 Claude Code、Codex 或 Antigravity，或者开一个新会话，让它们重新扫描 Skills。

## 13. 怎么确认运行成功

最简单的方法是打开图形界面：

```text
D:\My Files\AI_global_skills\打开SkillHub界面.cmd
```

然后看顶部状态：

```text
Sync succeeded = 同步成功
Sync failed = 同步失败
Running sync = 正在运行
```

界面下方的日志框会显示具体输出。如果失败，会显示失败原因。

也可以看同步报告：

```text
D:\My Files\AI_global_skills\reports\last-sync.md
```

报告里会列出：

```text
1. 当前 GitHub 仓库版本
2. 当前启用的 Skill
3. 哪些仓库只是 prompt，不作为 Skill 安装
4. 是否有冲突需要手动处理
```

如果是每日自动更新任务，可以在 PowerShell 中查询：

```powershell
schtasks.exe /Query /TN AISkillHubDailyUpdate /V /FO LIST
```

其中：

```text
Last Result = 0
```

表示上一次自动更新成功。

## 14. 如何做到自动更新

手动运行脚本是半自动。

如果想真正自动，可以安装 Windows 计划任务：

```powershell
powershell -ExecutionPolicy Bypass -File "D:\My Files\AI_global_skills\安装每日自动更新任务.ps1"
```

安装后，它会自动运行：

```text
每天上午 9:00
```

当前这台电脑已经安装成功：

```text
任务名：AISkillHubDailyUpdate
下次运行：每天 09:00
启动器：D:\AISkillHubLauncher\run-skillhub.cmd
```

我曾尝试添加“用户登录时自动运行”，但 Windows 对启动文件夹/登录触发任务有权限限制。为了稳定，不把它作为默认方案。每天 9 点自动更新已经能满足“无需手动点击”的核心需求。

如果以后不想自动更新了，运行：

```powershell
powershell -ExecutionPolicy Bypass -File "D:\My Files\AI_global_skills\卸载每日自动更新任务.ps1"
```

## 15. “永远最新”的真实含义

`skills` 目录已经通过链接指向 GitHub 源仓库，所以不需要再复制。

但 GitHub 不会主动推送到你的电脑。你的电脑仍然需要执行一次更新：

```text
git pull
```

所以“永远最新”的实际流程是：

```text
使用前运行一次 更新GitHub来源并同步Skills.ps1
↓
打开 Claude Code / Codex / Antigravity
↓
此时使用的就是 GitHub 当前最新版
```

如果不运行更新脚本，本地版本会停留在上一次更新时的状态。

如果安装了每日自动更新任务，这一步就由 Windows 每天自动完成。

## 16. 下次添加其它 GitHub Skill 怎么办

最方便的方法是打开图形界面：

```text
D:\My Files\AI_global_skills\打开SkillHub界面.cmd
```

在输入框粘贴 GitHub 地址，选择：

```text
skills = 真正的 Skill 仓库
prompt = 普通 prompt 资料仓库
```

然后点击：

```text
Add and Sync
```

SkillHub 会自动写入 `skillhub.config.json`，克隆仓库，扫描 `SKILL.md`，并建立链接。

也可以手动操作：

把新的 GitHub 仓库克隆到这里：

```text
D:\My Files\AI_global_skills\github_sources
```

然后运行：

```powershell
powershell -ExecutionPolicy Bypass -File "D:\My Files\AI_global_skills\SkillHub.ps1"
```

SkillHub 会自动扫描 `github_sources` 下的所有仓库。

如果它在新仓库里发现：

```text
某个文件夹\SKILL.md
```

就会自动把这个 Skill 链接到：

```text
D:\My Files\AI_global_skills\skills
```

如果某个以前管理过的 GitHub Skill 在新版本里不存在了，SkillHub 会自动删除旧链接，避免留下坏链接。

### 需要人工处理的情况

有些仓库会为不同工具生成很多份同名 Skill，比如：

```text
.claude\skills\xxx
.agents\skills\xxx
.cursor\skills\xxx
.gemini\skills\xxx
```

这种情况下 SkillHub 会按偏好顺序优先选择：

```text
1. .claude\skills
2. skills
3. .agents\skills
```

如果出现多个同名 Skill 且无法判断谁更合适，它会在 `reports\last-sync.md` 里写出 conflict。此时需要在 `skillhub.config.json` 里加一条明确规则。

## 17. 复制给师兄弟或另一台电脑怎么部署

最短流程：

```text
1. 把整个 AI_global_skills 文件夹复制过去
2. 在新电脑上运行 SkillHub.ps1
3. 重新打开 Claude Code / Codex / Antigravity
```

命令：

```powershell
powershell -ExecutionPolicy Bypass -File "D:\My Files\AI_global_skills\SkillHub.ps1"
```

如果复制到的路径不是 `D:\My Files\AI_global_skills`，也没有关系。

`SkillHub.ps1` 会以自己所在文件夹为根目录，重新生成链接。

注意：Windows 的 Junction 链接通常包含绝对路径。直接复制文件夹后，旧链接可能失效。所以新电脑第一次使用前，必须运行一次 `SkillHub.ps1` 来重建链接。

更友好的方式是运行图形界面：

```text
D:\My Files\AI_global_skills\打开SkillHub界面.cmd
```

然后点击：

```text
Sync Now
```

## 18. impeccable 的特殊说明

`impeccable` 仓库里有很多不同工具版本，例如 `.claude`、`.agents`、`.cursor`、`.gemini` 等。

这些不是多个不同 Skill，而是同一个 Skill 给不同工具生成的版本。

当前共享目录只链接了一份：

```text
D:\My Files\AI_global_skills\github_sources\impeccable\.claude\skills\impeccable
```

这样可以避免同一个 `impeccable` 被重复安装很多次。

## 19. 如果以后要开源

可以把这个文件夹整理成一个小项目，名字可以叫：

```text
AI SkillHub
```

第一版不建议做复杂 GUI，建议先保持：

```text
skillhub.config.json
SkillHub.ps1
安装每日自动更新任务.ps1
卸载每日自动更新任务.ps1
README.md
```

这样最容易被别人使用，也最容易跨电脑迁移。

等脚本版稳定后，再考虑做图形界面。



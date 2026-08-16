# 父子 Skill 路由不可打开问题：修复说明（交接文档）

日期：2026-08-16
分支备份：`backup/pre-router-abspath-fix`（修改前的 `d6d2c81`）
数据备份：`%LOCALAPPDATA%\AI SkillHub\UserData\backups\routers-before-abspath-fix-20260816-121012`

---

## 1. 结论先说

问题真实存在，而且不是"文件缺失"，是**声明的路径无法被接收方打开**。

修复前后同一台机器上的实测数据（`app-next/scripts/verify-live-router-children.mjs`）：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 父路由数量 | 43 | 43 |
| 声明的子 Skill 引用总数 | 914 | 914 |
| 物理路径可解析 | 914 | 914 |
| 从 `~/.claude/skills/<源>/` 入口可打开 | **0** | **914** |
| 从 `~/.codex/skills/<源>/` 入口可打开 | **0** | **914** |
| 从 `~/.agents/skills/<源>/` 入口可打开 | **0** | **914** |

修复前 2742 条声明（914 × 3 个宿主）全部打不开；修复后 0 条打不开。

顺带修掉两个自动更新相关的真实缺陷（见第 6、7 节）。

---

## 2. 根本原因（GPT 的判断方向对，机制描述需要修正）

生成的父路由原来把子 Skill 写成相对路径：

```
- [CHILD-SKILL] `$paper-spine` — …；来源文件：`../../PaperSpine/dist/claude/skills/paper-spine/SKILL.md`
```

而接收方（Claude Code / Codex / Antigravity）**从来不是在物理位置打开这个文件的**。它打开的是投递到自己家目录里的那一份，而那一份是 junction 链的末端：

```
~/.claude/skills/PaperSpine          (junction)
  └─> UserData/skills/PaperSpine     (junction)
        └─> UserData/sources/AI-SkillHub-local-routers/PaperSpine/   (实体目录)
```

关键点：`..` 跨过 junction 边界时，**不同消费者的解析结果不一样**：

- shell 用 `cd` 进去是**物理解析**，会跟着 junction 走，所以 `cd ~/.claude/skills/PaperSpine && ls ../../PaperSpine/dist` 是**成功**的；
- Node 的 `path.resolve`、Rust 的 `Path::join`、.NET 的 `Path.GetFullPath`，以及 LLM 自己在脑子里做路径运算，全都是**词法解析**，`../../` 直接从 `~/.claude/skills/PaperSpine` 退到 `~/`，得到 `~/PaperSpine/dist/...`，不存在。

而真实的接收方全部走词法解析。所以那 914 个引用在物理磁盘上都存在（`physical_ok=914`），但对任何一个 AI 宿主都是死路。

**需要修正 GPT 的一处描述**：这不是"Claude 从第一层入口做归一化"这种某一家实现的特性，而是"`..` 跨 junction 边界在各消费者之间行为不一致"这个更普遍的问题。所以修复方案不能只针对 Claude。

**GPT 漏掉的第二个问题**：`../../` 会把访问点带到已发布 Skill 目录**之外**。即使某个宿主碰巧按物理方式解析成功了，沙箱/权限层也可能直接拒绝这次读取。所以"能解析"和"能读到"是两件事，相对路径两件事都不保证。

---

## 3. 为什么没有采用 GPT 的 `source` junction 方案

GPT 的方案是在每个父路由目录里再建一个名为 `source` 的目录 junction 指回来源仓库，然后把子路径改写成 `source/.../SKILL.md`。

这个方案能跑，但比绝对路径差，理由：

1. **多加了一个 reparse point**。现在已经是两跳 junction，再加一跳变三跳。每多一跳，就多一处"物理解析 vs 词法解析"的分歧点，问题的形状没变，只是被推远了一层。
2. **没有消除歧义**。`source/x/SKILL.md` 仍然是相对路径，仍然要求消费者"相对本文件所在目录"去解析。而消费者到底认为"本文件所在目录"是 `~/.claude/skills/PaperSpine` 还是实体目录，这正是原来出错的地方。
3. **父路由是可重新生成的本机产物**，不需要具备可移植性。它不进 git、不跨机器复制，所以"绝对路径写死本机路径"在这里不是缺点。
4. **junction 只能同卷**。sources 目录和 UserData 一定同卷，但一旦以后允许用户把源目录放到别的盘，方案直接失效。
5. **不可导出**。带 junction 的目录被复制/打包时行为不可预测；纯文本绝对路径至少是可诊断的。

绝对路径的唯一代价是"用户搬动 sources 根目录后路径失效"，这一点已经被自动处理（见第 5 节）。

---

## 4. 改了什么

### 4.1 Rust 生成器 `app-next/src-tauri/src/lib.rs`

| 位置 | 内容 |
|---|---|
| `struct RouterChildLink`（15262） | 新增。承载 `name` / `absolute_path` / `relative_path` / `summary`。文档注释里写清了"为什么相对路径在 junction 链上必然失效"，避免以后有人又改回去。 |
| `fn router_child_absolute_path`（15274） | 新增。`canonicalize` → 去掉扩展长度前缀 → 统一正斜杠。 |
| `fn strip_extended_length_prefix`（15283） | 新增。处理 `\\?\UNC\` 和 `\\?\` 两种前缀。 |
| `fn collect_child_skill_links_for_collection`（15299） | **修掉一个数据丢失 bug**，详见 4.3。 |
| `fn build_router_hub_skill_md`（14782） | 输出绝对路径；同名子项加位置后缀；路由规则文案重写。 |

路由规则文案（去掉了硬编码的 `../../{collection}`）：

```
- 下方每个子 Skill 都给出完整绝对路径。执行前必须先用文件读取工具打开该路径的全文，不要凭名称或摘要推测其内容。
- 路径请原样使用，不要拼接、不要相对化、不要基于本文件所在目录再做解析。
- 只能打开下方明确列出的、属于来源 `{collection}` 的文件。
```

### 4.2 PowerShell 生成器 `app-next/runtime/SkillHub.ps1`

`Ensure-CollectionRouterSkill`（646）同步改造。**这个函数才是最终落盘的那一个**——`run_skillhub_sync_blocking`（`lib.rs:1554`）的顺序是：

```
PS(带 pull) → Rust 生成路由 → PS(不 pull) → agent 链接 → 诊断导出
```

PowerShell 最后写，所以两个生成器必须逐字一致，只改 Rust 是没有效果的（这也解释了为什么之前 Rust 里的去重 bug 在磁盘上看不出来）。

- `$childNameCounts`（672）：按 `Normalize-SkillLookupName` 统计同名数量。
- `$absoluteChild`（690）：`Convert-ToFullPath` 后统一正斜杠。
- 同名时的位置后缀（694）相对**来源根**（`Join-Path $SourceRoot $RepoName`）计算，和 Rust 保持一致。
- `Sort-Object Skill` → `Sort-Object Skill, Source`，保证同名项顺序稳定，避免每次同步都产生无意义的正文 diff。

> ⚠️ 给后续维护者的坑：`SkillHub.ps1` **没有 UTF-8 BOM**，Windows PowerShell 5.1 会按 ANSI 读它。文件里所有非 ASCII 字面量必须用 code point 拼（`[char]0xFF08` 等），直接写中文会变乱码并导致解析错误。测试脚本 `test-parent-router-powershell.ps1` 同样如此。

### 4.3 顺带修掉的数据丢失 bug（重要）

原来的 `collect_child_skill_links_for_collection` 返回 `BTreeMap<String, (String, String, String)>`，用的是：

```rust
links.entry(key).or_insert(...)
```

也就是说**同一个来源内 `name:` 相同的子 Skill，只保留第一个，其余静默丢弃**。

PaperSpine 就是活例子：它在 5 个路径下都提供了 `name: paper-spine`（`src/skill`、`dist/claude/...`、`dist/codex/...`、`dist/hermes/...`、`dist/openclaw/...`）。这是 5 个真实可调用的 Skill，按名字去重会直接删掉 4 个能力。

现已改为 `Vec<RouterChildLink>` + `links.push(...)`，一个都不丢，并加了确定性排序：

```rust
links.sort_by(|left, right| {
    normalize_skill_lookup(&left.name)
        .cmp(&normalize_skill_lookup(&right.name))
        .then_with(|| left.relative_path.to_lowercase().cmp(&right.relative_path.to_lowercase()))
});
```

同名项用它在来源内的位置来区分，实际生成结果：

```
- [CHILD-SKILL] `$paper-spine` （dist/claude/skills/paper-spine） — …；来源文件：`C:/Users/…/sources/PaperSpine/dist/claude/skills/paper-spine/SKILL.md`
- [CHILD-SKILL] `$paper-spine` （dist/codex/skills/paper-spine） — …；来源文件：`C:/Users/…/sources/PaperSpine/dist/codex/skills/paper-spine/SKILL.md`
- [CHILD-SKILL] `$paper-spine` （dist/hermes/skills/academic-writing/paper-spine） — …
- [CHILD-SKILL] `$paper-spine` （dist/openclaw/skills/paper-spine） — …
- [CHILD-SKILL] `$paper-spine` （src/skill） — …
```

并在路由规则里加了一句让 Agent 知道怎么选：

```
- 同名子项后面括号内是它在来源中的位置，用于区分；按用户意图选择其一。
```

**跨来源同名的隔离规则没有改**：父路由仍然只能加载自己来源下的子 Skill，绝不跨来源替换。

---

## 5. 绝对路径引入的唯一新风险，以及它是怎么被处理的

风险：用户把 sources 根目录搬走后，路由里写死的绝对路径全部失效。

处理方式：**不需要额外的失效状态机**。因为路径是绝对的，根目录一变，43 个路由的正文内容就全变了，而生成器本来就是"正文有 diff 才重写"。所以搬目录这件事自动落进既有的重建触发条件里。

已用测试锁死（`lib.rs:17464` `relocating_the_sources_root_rewrites_absolute_child_paths`）：

1. 同一个 collection 在两个不同临时根下生成，断言正文不同；
2. 断言搬迁后每个声明的子路径都能真的打开；
3. 断言没有任何路径还指向旧根；
4. 断言在未变化的树上重跑返回 `status == "unchanged"`，保证日常同步仍是 no-op，不会每次都重写 43 个文件。

`docs/skill-router-standard.md` 的规则 9 已补上"sources 根变化"这个重建触发条件。

---

## 6. 关于"点击更新自动同步 GitHub 最新版本"

### 6.1 机制本身是正常的

链路：UI 刷新 → `run_skillhub_sync`（`App.tsx:693`）→ `run_skillhub_sync_blocking`（`lib.rs:1554`）→ `SkillHub.ps1`（带 pull）。

`SkillHub.ps1` 里有两条 pull 路径：

- 配置仓库：1070 行起，遍历 `$Config.repositories`；
- **自动发现仓库：1170 行起**（`if ($Config.autoDiscoverManualRepos -and -not $ReportOnly -and -not $NoPull)`）。

注意：你这台机器上 `skillhub.config.json` 里 `"repositories": []`、`"autoDiscoverManualRepos": true`，也就是 **47 个源全部走第二条路径**。这条路径存在且正确：`git pull --ff-only`，配合脏工作区检查、pin 清单、`$GitCommandTimeoutSeconds = 18`、`$GitUpdateBudgetSeconds = 95`，缺失的仓库回落到 `git clone`。

所以"点击更新会拉取 GitHub 最新版本"这个功能是**在工作的**。

### 6.2 但有一个真实缺陷：软件自己的文件把自己的更新堵死了

实测源目录状态：

```
total=47  with_git=44  without_git=3  dirty=12
```

那 12 个"脏"仓库因为 `git status --porcelain` 非空，被打上 `dirty-blocked`，**永久跳过更新**。逐个查下去发现，其中 8 个之所以脏，完全是 **AI SkillHub 自己写进去的未跟踪文件**：

- `.skillhub-source.json` —— `src-tauri/src/metadata.rs:364` 写的托管元数据；
- `.skillhub-extracted/` —— `runtime/SkillHub.ps1:780` 解压 zip 时建的目录。

也就是说：**只要软件碰过某个源，那个源就再也不会自动更新了**。这是个自伤型缺陷，而且越用越严重。

### 6.3 修复

`SkillHub.ps1` 新增（1036–1063）：

```powershell
$SelfAuthoredRepoArtifacts = @('.skillhub-source.json', '.skillhub-extracted')
function Test-PorcelainEntryIsSelfAuthored([string]$Line) { … }
function Get-BlockingWorkingTreeChanges([string]$Porcelain) { … }
```

两处脏检查（1116、1197）改为只在**过滤掉软件自身产物之后仍有变更**时才 `dirty-blocked`。

安全边界，刻意保留：

- 只忽略 `??`（未跟踪）条目。如果同名文件是**被 git 跟踪**的（说明它属于上游仓库），任何改动照旧阻断 pull。
- 只忽略这两个已知产物，不做通配。比如 `nature-skills` 里的 `nature-figure.zip` 是用户/导入流程放进去的输入文件，**不忽略**，继续保护。

修复效果（同一台机器实测）：

| 源 | 结果 | 原因 |
|---|---|---|
| AIScientists-Dev--academic-humanizer | ✅ 恢复更新 | 只有 `.skillhub-source.json` |
| Galaxy-Dawn--claude-scholar | ✅ 恢复更新 | 同上 |
| cLin-c--paper-skill | ✅ 恢复更新 | 同上 |
| karpathy--autoresearch | ✅ 恢复更新 | 同上 |
| microsoft--ResearchStudio | ✅ 恢复更新 | 同上 |
| wanshuiyin--Auto-claude-code-research-in-sleep | ✅ 恢复更新 | 同上 |
| paper-framework-figure-studio-pro | ✅ 恢复更新 | 只有 `.skillhub-extracted/` |
| scientific-figure-skill | ✅ 恢复更新 | 同上 |
| nature-skills | ⛔ 仍阻断 | 未跟踪的 `nature-figure.zip`（用户输入，应当保护） |
| Research-Paper-Writing-Skills | ⛔ 仍阻断 | 已跟踪文件被改（`research-paper-writing/SKILL.md`） |
| codex-plugin-repair-windows-skill | ⛔ 仍阻断 | 2 个已跟踪文件被改 + 一个 `.bak` |
| scientific-agent-skills | ⛔ 仍阻断 | 395 个已跟踪文件被改 |

**可自动更新的源：32/44 → 40/44。**

### 6.4 还有 4 个源需要用户决定，软件不应该自己动

- `scientific-agent-skills`：工作区内容其实比 HEAD **更新**（`pyproject.toml` 里工作区是 `2.55.0`，提交是 `2.54.0`）。看起来是曾经用 zip 解压覆盖了一个 git 检出，导致 395 个跟踪文件永久"已修改"，`--ff-only` 从此永久失败。建议在 UI 里提供"放弃本地改动并回到上游"的显式操作，而不是让软件静默 `checkout .`。
- `academic-research-skills-codex`、`aytzey--paper-pilot`、`mineru-document-extractor`：3 个源**没有 `.git` 目录**，属于手工/zip 导入，天生无法 `git pull`。它们不在"更新失败"范畴，但 UI 上最好和"可更新源"区分显示，否则用户会误以为更新坏了。

这两条我**没有动**，因为都涉及丢弃用户内容或改变产品语义，应当由你们决定。

---

## 7. 测试契约

原来有两处断言只做字符串包含检查，实际上正是在为 bug 背书：

```rust
assert!(alpha.contains("../../alpha/shared-review/SKILL.md"));
assert!(body.contains("../../nature-skills/nature-skills/SKILL.md"));
```

这种断言只能证明"我们写出了这个字符串"，不能证明"接收方能打开它"。已全部替换为**逐个真实打开**：

```rust
fn declared_child_paths(router_body: &str) -> Vec<String>      // lib.rs:17283
fn assert_every_declared_child_opens(router_body: &str, context: &str) -> usize  // lib.rs:17301
```

`assert_every_declared_child_opens` 对每条声明断言三件事：是绝对路径、不含 `..`、`fs::read_to_string` 成功。

新增测试：

| 测试 | 位置 | 锁死的内容 |
|---|---|---|
| `router_hub_keeps_every_same_name_child_inside_one_source` | `lib.rs:17326` | 同名子项一个都不丢（断言 `child_count == 4` 及三个位置后缀） |
| `declared_children_open_through_the_agent_delivery_junction_chain` | `lib.rs:17397` | `#[cfg(windows)]`，真建两跳 junction 链，从投递入口打开每个声明 |
| `relocating_the_sources_root_rewrites_absolute_child_paths` | `lib.rs:17464` | 搬根后路径重写、旧根不残留、未变化时仍 `unchanged` |
| PowerShell 侧同名/junction 断言 | `scripts/test-parent-router-powershell.ps1` | 3 个同名子项不丢 + 位置后缀 + junction 链可达 |
| `the app's own bookkeeping never blocks a source from tracking GitHub` | `scripts/v3.1.6-update-sync-contract.test.mjs` | 两处脏检查都必须走过滤；只忽略 `??` |
| `metadata-only-repo` / `tracked-metadata-repo` | `scripts/test-sync-runtime-resilience.ps1` | 前者必须 `ok`，后者必须 `dirty-blocked` |

新增诊断脚本：

```
node app-next/scripts/verify-live-router-children.mjs [sourcesFolder]
```

对真实安装数据做验收：解析 43 个路由的每条 `[CHILD-SKILL]` 声明，然后从 `~/.claude`、`~/.codex`、`~/.agents` 三个投递入口分别 `path.resolve` 并检查是否存在。任何一条打不开就以非 0 退出。这个脚本是这次修复的验收标准，也建议放进 CI。

### 全量测试结果

```
cargo test --lib                                 143 passed; 0 failed; 5 ignored
node --test scripts/*.test.mjs                    60 passed; 0 failed
test-parent-router-powershell.ps1                 PASS ×2
test-sync-runtime-resilience.ps1                  PASS ×2 (powershell + pwsh)
test-diagnostics-index-integrity.ps1              PASS
test-codex-skill-delivery.ps1                     PASS ×8
test-update-channel-health.ps1                    PASS (3/3 manifests → v3.1.11)
verify-live-router-children.mjs                   914/914 × 3 hosts
```

`test-final-recipient-import.ps1` 需要 `-PackagePath` 指向已构建的安装包，属于发版打包验证，本次未构建安装包，因此未运行。

---

## 8. 已在真实数据上生效

生成器改完后，用真实配置跑了一次落盘同步：

```powershell
$env:AI_SKILLHUB_CONFIG_PATH = "C:\Users\Francis\AppData\Local\AI SkillHub\UserData\skillhub.config.json"
$env:AI_SKILLHUB_STATE       = "C:\Users\Francis\AppData\Local\AI SkillHub\UserData\state"
$env:AI_SKILLHUB_REPORTS     = "C:\Users\Francis\AppData\Local\AI SkillHub\UserData\reports"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File app-next\runtime\SkillHub.ps1 -NoPull
```

结果 `Active managed skills: 43`，随后验收脚本 914/914 全通过。旧路由已备份到 `UserData\backups\routers-before-abspath-fix-20260816-121012`。

用了 `-NoPull`，所以这一步**没有碰任何 git 仓库**，只重写了本机生成的路由文件。

---

## 9. 建议 Codex 复核的点

1. `lib.rs` 和 `SkillHub.ps1` 两个生成器的输出是否**逐字**一致。目前靠 `test-parent-router-powershell.ps1` 和 Rust 测试各自断言同一批不变量，但没有一个测试直接 diff 两者的输出。这是最值得补的一个测试。
2. `strip_extended_length_prefix` 对 UNC 路径（`\\server\share\...`）的处理。有分支但没有 UNC 测试用例，因为本机造不出干净的 UNC 环境。
3. `Test-PorcelainEntryIsSelfAuthored` 对 git 引号转义路径的解析。目前只剥了首尾双引号，没有处理 `\t`、`\302\251` 这类八进制/转义序列。这只影响"是否忽略"这个判断，最坏结果是把某个自身产物误判为用户改动（保守方向，不会误删用户内容），但可以更严谨。
4. 第 6.4 节那 4 个源的产品决策：脏工作区如何呈现给用户、是否提供显式的"放弃本地改动"、非 git 源在 UI 上如何区分。
5. 是否把 `verify-live-router-children.mjs` 加进发版前检查。

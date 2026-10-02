import { getLang } from "./i18n";
import type { Lang } from "./i18n";
import type { SourceCard, SourceUpdateOutcome, SourceUpdateRun, SourceUpdateRunEntry } from "./types";

/** Display order: what needs attention first, quiet results last. */
export const SOURCE_UPDATE_OUTCOMES: SourceUpdateOutcome[] = [
  "failed",
  "local-changes",
  "deferred",
  "updated",
  "unchanged",
  "pinned",
  "not-git"
];

/** One background "update all" never chains more than this many rounds. */
export const MAX_AUTO_CONTINUE_ROUNDS = 5;

export type SourceUpdateRunSummary = {
  total: number;
  checked: number;
  pending: number;
  counts: Record<SourceUpdateOutcome, number>;
  addedSkills: number;
  discoveredSkills: number;
  keptLocal: number;
  finished: boolean;
};

export function summarizeSourceUpdateRun(run?: SourceUpdateRun | null): SourceUpdateRunSummary {
  const counts = Object.fromEntries(SOURCE_UPDATE_OUTCOMES.map(outcome => [outcome, 0])) as Record<SourceUpdateOutcome, number>;
  let addedSkills = 0;
  let discoveredSkills = 0;
  let keptLocal = 0;
  for (const entry of run?.sources ?? []) {
    const outcome = normalizeOutcome(entry.outcome);
    counts[outcome] += 1;
    addedSkills += entry.addedSkills?.length ?? 0;
    discoveredSkills += entry.discoveredSkills?.length ?? 0;
    keptLocal += entry.keptLocalPaths?.length ?? 0;
  }
  const total = run?.sources?.length ?? 0;
  const pending = counts.deferred;
  return {
    total,
    checked: total - pending,
    pending,
    counts,
    addedSkills,
    discoveredSkills,
    keptLocal,
    finished: total > 0 && pending === 0
  };
}

export function normalizeOutcome(outcome: string): SourceUpdateOutcome {
  return (SOURCE_UPDATE_OUTCOMES as string[]).includes(outcome) ? (outcome as SourceUpdateOutcome) : "failed";
}

export function sortSourceUpdateEntries(entries: SourceUpdateRunEntry[]): SourceUpdateRunEntry[] {
  const rank = (entry: SourceUpdateRunEntry) => SOURCE_UPDATE_OUTCOMES.indexOf(normalizeOutcome(entry.outcome));
  return [...entries].sort((left, right) =>
    rank(left) - rank(right)
    || (right.addedSkills?.length ?? 0) - (left.addedSkills?.length ?? 0)
    || left.folder.localeCompare(right.folder, undefined, { sensitivity: "base" })
  );
}

/** True when the run still has waiting sources and the round budget allows another pass. */
export function shouldAutoContinue(run: SourceUpdateRun | null | undefined, roundsThisClick: number, stopped: boolean) {
  if (stopped || !run) return false;
  return summarizeSourceUpdateRun(run).pending > 0 && roundsThisClick < MAX_AUTO_CONTINUE_ROUNDS;
}

/** Project name first, author second, from the repository identity; a
 * folder name alone is shown as it is (its `--` order varies across versions). */
export function sourceFolderLabel(folder: string, identity = ""): { title: string; owner: string } {
  const [owner, repo] = identity.split("/");
  if (owner && repo) return { title: repo, owner };
  return { title: folder, owner: "" };
}

/** Short leaf name for a Skill path such as `skills/research/foo` → `foo`. */
export function skillPathLeaf(path: string): string {
  const trimmed = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!trimmed) return "/";
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

export function formatRunTime(value: string, lang: Lang = getLang()): string {
  if (!value) return "";
  const parsed = Date.parse(value.replace(" UTC", "Z").replace(" ", "T"));
  if (Number.isNaN(parsed)) return value;
  const locale = lang === "zh" ? "zh-CN" : lang === "ko" ? "ko-KR" : "en-US";
  return new Intl.DateTimeFormat(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(parsed);
}

type Dictionary = Record<string, string>;

const zh: Dictionary = {
  "run.latest": "已是最新",
  "run.updatedShort": "已更新 {n}",
  "run.partialFailed": "部分失败",
  "run.checkFailed": "检查失败",
  "run.waitingShort": "待继续",
  "run.skippedShort": "部分未更新",
  "run.latestToast": "已是最新，本次已检查 {n} 个来源。",
  "run.toastSkipped": "，{n} 个未更新（固定版本、本地修改或无上游）",
  "run.expand": "展开记录",
  "run.collapse": "收起记录",
  "run.title": "来源更新",
  "run.subtitle": "上次“更新全部”的逐个结果",
  "run.progress": "已检查 {checked}/{total}",
  "run.pending": "{n} 个待继续",
  "run.finished": "本轮检查结束",
  "run.checkedAt": "检查于 {time}",
  "run.rounds": "{n} 轮",
  "run.continue": "继续更新剩余 {n} 个",
  "run.continuing": "正在继续：剩余 {n} 个来源 · 第 {round} 轮",
  "run.stop": "本轮结束后停止",
  "run.stopped": "已停止。剩余 {n} 个来源保留在“待继续”，随时可以继续。",
  "run.filterAll": "全部 {n}",
  "run.empty": "还没有完整的更新记录。点击右上角“更新全部”开始。",
  "run.addedSkills": "新增 Skill：{names}",
  "run.discovered": "发现 {n} 个新 Skill（未启用，因为此来源只安装你选定的部分）",
  "run.keptLocal": "{n} 个文件保留了你本地的版本",
  "run.dependencies": "补齐依赖目录：{names}",
  "run.tracking": "跟踪 {branch}",
  "run.reloadHint": "新增的 Skill 已投递。已打开的 AI 客户端可能需要重新开始会话才能看到。",
  "run.toast": "已检查 {checked}/{total} 个来源：{updated} 个更新、{unchanged} 个无变化{rest}",
  "run.toastPending": "，{n} 个待继续",
  "run.toastFailed": "，{n} 个失败",
  "run.toastAdded": "，新增 {n} 个 Skill",
  "outcome.updated": "已更新",
  "outcome.unchanged": "无变化",
  "outcome.pinned": "固定版本",
  "outcome.local-changes": "本地修改",
  "outcome.failed": "失败",
  "outcome.deferred": "待继续",
  "outcome.not-git": "需重新添加",
  "hint.local-changes": "检测到你改过的文件，已跳过更新以免覆盖。",
  "hint.deferred": "本轮时间用完，下一轮会优先处理。",
  "hint.not-git": "这个文件夹没有来源记录，无法自动更新；删除后用 GitHub 地址重新添加即可。",
  "hint.pinned": "已固定在指定版本，同步不会改动它。"
};

const en: Dictionary = {
  "run.latest": "Up to date",
  "run.updatedShort": "Updated {n}",
  "run.partialFailed": "Some failed",
  "run.checkFailed": "Check failed",
  "run.waitingShort": "Continue",
  "run.skippedShort": "Some skipped",
  "run.latestToast": "Up to date. Checked {n} sources in this run.",
  "run.toastSkipped": ", {n} skipped (pinned, local edits or no upstream)",
  "run.expand": "Show records",
  "run.collapse": "Hide records",
  "run.title": "Source updates",
  "run.subtitle": "Per-source results of the last “Update all”",
  "run.progress": "Checked {checked}/{total}",
  "run.pending": "{n} waiting",
  "run.finished": "Check complete",
  "run.checkedAt": "Checked {time}",
  "run.rounds": "{n} rounds",
  "run.continue": "Continue the remaining {n}",
  "run.continuing": "Continuing: {n} sources left · round {round}",
  "run.stop": "Stop after this round",
  "run.stopped": "Stopped. {n} sources stay waiting; continue any time.",
  "run.filterAll": "All {n}",
  "run.empty": "No complete update record yet. Use “Update all” at the top right.",
  "run.addedSkills": "New Skills: {names}",
  "run.discovered": "Found {n} new Skills (not enabled: this source installs only your selection)",
  "run.keptLocal": "{n} files kept your local version",
  "run.dependencies": "Added linked folders: {names}",
  "run.tracking": "Tracks {branch}",
  "run.reloadHint": "New Skills are delivered. An AI client that is already open may need a new session to see them.",
  "run.toast": "Checked {checked}/{total} sources: {updated} updated, {unchanged} unchanged{rest}",
  "run.toastPending": ", {n} waiting",
  "run.toastFailed": ", {n} failed",
  "run.toastAdded": ", {n} new Skills",
  "outcome.updated": "Updated",
  "outcome.unchanged": "Unchanged",
  "outcome.pinned": "Pinned",
  "outcome.local-changes": "Local edits",
  "outcome.failed": "Failed",
  "outcome.deferred": "Waiting",
  "outcome.not-git": "Re-add needed",
  "hint.local-changes": "Files you changed were found, so the update was skipped to keep them.",
  "hint.deferred": "This round ran out of time; the next round handles it first.",
  "hint.not-git": "This folder has no source record and cannot update itself. Remove it and add the GitHub URL again.",
  "hint.pinned": "Pinned to a fixed version; sync leaves it unchanged."
};

const ko: Dictionary = {
  "run.latest": "최신 상태",
  "run.updatedShort": "{n}개 업데이트",
  "run.partialFailed": "일부 실패",
  "run.checkFailed": "확인 실패",
  "run.waitingShort": "계속 필요",
  "run.skippedShort": "일부 건너뜀",
  "run.latestToast": "최신 상태입니다. 이번에 소스 {n}개를 확인했습니다.",
  "run.toastSkipped": ", {n}개 건너뜀(버전 고정, 로컬 수정 또는 원본 없음)",
  "run.expand": "기록 펼치기",
  "run.collapse": "기록 접기",
  "run.title": "소스 업데이트",
  "run.subtitle": "마지막 “모두 업데이트”의 소스별 결과",
  "run.progress": "{checked}/{total} 확인",
  "run.pending": "{n}개 대기",
  "run.finished": "확인 완료",
  "run.checkedAt": "{time} 확인",
  "run.rounds": "{n}회차",
  "run.continue": "남은 {n}개 계속",
  "run.continuing": "계속하는 중: 남은 소스 {n}개 · {round}회차",
  "run.stop": "이번 회차 후 중지",
  "run.stopped": "중지했습니다. 남은 소스 {n}개는 대기 상태로 남아 언제든 계속할 수 있습니다.",
  "run.filterAll": "전체 {n}",
  "run.empty": "아직 완료된 업데이트 기록이 없습니다. 오른쪽 위 “모두 업데이트”를 누르세요.",
  "run.addedSkills": "새 Skill: {names}",
  "run.discovered": "새 Skill {n}개 발견(선택한 항목만 설치하는 소스라 활성화하지 않음)",
  "run.keptLocal": "파일 {n}개는 로컬 버전을 유지했습니다",
  "run.dependencies": "연결된 폴더 추가: {names}",
  "run.tracking": "{branch} 추적",
  "run.reloadHint": "새 Skill을 전달했습니다. 이미 열린 AI 클라이언트는 새 세션을 시작해야 보일 수 있습니다.",
  "run.toast": "소스 {checked}/{total}개 확인: {updated}개 업데이트, {unchanged}개 변경 없음{rest}",
  "run.toastPending": ", {n}개 대기",
  "run.toastFailed": ", {n}개 실패",
  "run.toastAdded": ", 새 Skill {n}개",
  "outcome.updated": "업데이트됨",
  "outcome.unchanged": "변경 없음",
  "outcome.pinned": "버전 고정",
  "outcome.local-changes": "로컬 수정",
  "outcome.failed": "실패",
  "outcome.deferred": "대기",
  "outcome.not-git": "다시 추가 필요",
  "hint.local-changes": "직접 수정한 파일이 있어 덮어쓰지 않도록 업데이트를 건너뛰었습니다.",
  "hint.deferred": "이번 회차 시간이 끝났습니다. 다음 회차에서 먼저 처리합니다.",
  "hint.not-git": "소스 기록이 없는 폴더라 자동 업데이트할 수 없습니다. 삭제 후 GitHub 주소로 다시 추가하세요.",
  "hint.pinned": "지정한 버전에 고정되어 동기화가 변경하지 않습니다."
};

const dictionaries: Record<Lang, Dictionary> = { zh, en, ko };

export function rt(key: string, vars?: Record<string, string | number>): string {
  let text = dictionaries[getLang()][key] ?? en[key] ?? key;
  for (const [name, value] of Object.entries(vars ?? {})) {
    text = text.split(`{${name}}`).join(String(value));
  }
  return text;
}

export function sourceUpdateToast(run: SourceUpdateRun | null | undefined): { message: string; tone: "ok" | "warn" | "error" } | null {
  const summary = summarizeSourceUpdateRun(run);
  if (summary.total === 0) return null;
  if (summary.counts.unchanged === summary.total && summary.keptLocal === 0) {
    return { message: rt("run.latestToast", { n: summary.total }), tone: "ok" };
  }
  let rest = "";
  if (summary.addedSkills > 0) rest += rt("run.toastAdded", { n: summary.addedSkills });
  if (summary.counts.failed > 0) rest += rt("run.toastFailed", { n: summary.counts.failed });
  if (summary.pending > 0) rest += rt("run.toastPending", { n: summary.pending });
  const skipped = summary.counts.pinned + summary.counts["not-git"] + summary.counts["local-changes"];
  if (skipped > 0) rest += rt("run.toastSkipped", { n: skipped });
  if (summary.keptLocal > 0) rest += ` · ${rt("run.keptLocal", { n: summary.keptLocal })}`;
  const message = rt("run.toast", {
    checked: summary.checked,
    total: summary.total,
    updated: summary.counts.updated,
    unchanged: summary.counts.unchanged,
    rest
  });
  const tone = summary.counts.failed > 0 && summary.counts.failed === summary.checked
    ? "error"
    : summary.counts.failed > 0 || summary.pending > 0 || skipped > 0 || summary.keptLocal > 0
      ? "warn"
      : "ok";
  return { message, tone };
}

/** This is a dated result of a real check, never a live promise about upstream. */
export function sourceUpdateFeedback(run: SourceUpdateRun | null | undefined, sources?: Pick<SourceCard, "localPath" | "name">[]) {
  if (!run?.updatedAt) return null;
  if (sources) {
    const folders = sources.map(source => skillPathLeaf(source.localPath || source.name).toLowerCase())
      .filter(folder => folder !== "ai-skillhub-local-routers");
    const checked = new Set(run.sources.map(source => source.folder.toLowerCase()));
    // Adding/removing/renaming a source invalidates the whole-library claim.
    if (!folders.length || folders.length !== checked.size || folders.some(folder => !checked.has(folder))) return null;
  }
  const toast = sourceUpdateToast(run);
  if (!toast) return null;
  const { counts, pending, total, keptLocal } = summarizeSourceUpdateRun(run);
  const label = counts.failed > 0 ? rt(counts.failed === total ? "run.checkFailed" : "run.partialFailed")
    : pending > 0 ? rt("run.waitingShort")
    : counts.pinned + counts["not-git"] + counts["local-changes"] + keptLocal > 0 ? rt("run.skippedShort")
    : counts.updated > 0 ? rt("run.updatedShort", { n: counts.updated })
    : rt("run.latest");
  return { ...toast, label, message: `${rt("run.checkedAt", { time: formatRunTime(run.updatedAt) })} · ${toast.message}` };
}

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { getLang } from "./i18n";
import type { Lang } from "./i18n";
import { Icon } from "./icons";
import type { LegacySnapshot } from "./types";

export type IdentityPlanEntry = {
  sourceId: string;
  folder: string;
  identity: string;
  owner: string;
  repo: string;
  githubRepoId: number | null;
  githubFullName: string;
  currentParent: string;
  targetParent: string;
  targetFolder: string;
  action: "aligned" | "rename" | "local" | "ambiguous" | "blocked" | string;
  reasons: string[];
};

export type IdentityPlan = {
  entries: IdentityPlanEntry[];
  renameCount: number;
  alignedCount: number;
  attentionCount: number;
  interrupted: boolean;
};

type Props = {
  runtimeAvailable: boolean;
  disabled: boolean;
  onApplied: (snapshot: LegacySnapshot) => void;
  onError: (message: string) => void;
};

export function SourceIdentityPanel({ runtimeAvailable, disabled, onApplied, onError }: Props) {
  const [plan, setPlan] = useState<IdentityPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [expanded, setExpanded] = useState(false);

  async function refresh() {
    if (!runtimeAvailable) return;
    setLoading(true);
    try {
      const next = await invoke<IdentityPlan>("plan_source_identity_migration");
      setPlan(next);
      setSelected(new Set(next.entries.filter(entry => entry.action === "rename").map(entry => entry.sourceId)));
    } catch (error) {
      onError(String(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // Load once when the panel mounts; later refreshes are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeAvailable]);

  const renames = useMemo(() => plan?.entries.filter(entry => entry.action === "rename") ?? [], [plan]);
  const attention = useMemo(() => plan?.entries.filter(entry => entry.action === "ambiguous" || entry.action === "blocked") ?? [], [plan]);

  async function apply() {
    if (!plan || applying) return;
    setApplying(true);
    try {
      const snapshot = await invoke<LegacySnapshot>("apply_source_identity_migration", {
        sourceIds: plan.interrupted ? [] : [...selected]
      });
      onApplied(snapshot);
      setConfirming(false);
      await refresh();
    } catch (error) {
      onError(String(error));
      await refresh();
    } finally {
      setApplying(false);
    }
  }

  if (!runtimeAvailable) return null;
  const busy = disabled || loading || applying;
  const allSelected = renames.length > 0 && renames.every(entry => selected.has(entry.sourceId));

  return (
    <section className="identity-panel" aria-label={it("title")}>
      <header className="identity-head">
        <div>
          <h3>{it("title")}</h3>
          <p>{it("body")}</p>
        </div>
        <button className="ghost-action small" disabled={busy} onClick={() => void refresh()} type="button">
          <Icon className={loading ? "icon-spin" : ""} name="refresh" /> {it("recheck")}
        </button>
      </header>

      {plan && (
        <dl className="identity-stats">
          <div><dt>{it("statRename")}</dt><dd>{plan.renameCount}</dd></div>
          <div><dt>{it("statAligned")}</dt><dd>{plan.alignedCount}</dd></div>
          <div><dt>{it("statAttention")}</dt><dd>{plan.attentionCount}</dd></div>
        </dl>
      )}

      {plan?.interrupted && (
        <div className="identity-callout is-warning" role="alert">
          <p>{it("interrupted")}</p>
          <button className="primary-action small" disabled={busy} onClick={() => void apply()} type="button">
            {it("finish")}
          </button>
        </div>
      )}

      {renames.length > 0 && !plan?.interrupted && (
        <>
          <div className="identity-table-head">
            <label className="identity-check">
              <input
                checked={allSelected}
                disabled={busy}
                onChange={event => setSelected(event.target.checked ? new Set(renames.map(entry => entry.sourceId)) : new Set())}
                type="checkbox"
              />
              {it("selectAll", { n: renames.length })}
            </label>
            <button className="text-action" onClick={() => setExpanded(value => !value)} type="button">
              {expanded ? it("collapse") : it("expand")}
            </button>
          </div>
          <ul className={expanded ? "identity-list is-expanded" : "identity-list"}>
            {(expanded ? renames : renames.slice(0, 6)).map(entry => (
              <li key={entry.sourceId}>
                <label className="identity-check">
                  <input
                    checked={selected.has(entry.sourceId)}
                    disabled={busy}
                    onChange={event => {
                      const next = new Set(selected);
                      if (event.target.checked) next.add(entry.sourceId); else next.delete(entry.sourceId);
                      setSelected(next);
                    }}
                    type="checkbox"
                  />
                  <span className="identity-repo">
                    <strong>{entry.repo || entry.folder}</strong>
                    <small>{entry.owner}</small>
                  </span>
                </label>
                <code className="identity-old">/{entry.currentParent}</code>
                <span className="identity-arrow" aria-hidden="true">→</span>
                <code className="identity-new">/{entry.targetParent}</code>
              </li>
            ))}
          </ul>
          {!expanded && renames.length > 6 && <p className="identity-more">{it("more", { n: renames.length - 6 })}</p>}
          {!confirming ? (
            <button
              className="primary-action"
              disabled={busy || selected.size === 0}
              onClick={() => setConfirming(true)}
              type="button"
            >
              {it("apply", { n: selected.size })}
            </button>
          ) : (
            <div className="identity-callout" role="alertdialog" aria-label={it("confirmTitle")}>
              <strong>{it("confirmTitle")}</strong>
              <ul>
                <li>{it("confirmNames")}</li>
                <li>{it("confirmKeep")}</li>
                <li>{it("confirmBackup")}</li>
              </ul>
              <div className="identity-actions">
                <button className="ghost-action" disabled={applying} onClick={() => setConfirming(false)} type="button">{it("cancel")}</button>
                <button className="primary-action" disabled={busy} onClick={() => void apply()} type="button">
                  {applying ? it("applying") : it("confirm", { n: selected.size })}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {plan && renames.length === 0 && !plan.interrupted && attention.length === 0 && (
        <p className="identity-done">{it("allAligned")}</p>
      )}

      {attention.length > 0 && (
        <ul className="identity-attention">
          {attention.map(entry => (
            <li key={entry.sourceId}>
              <strong>{entry.repo || entry.folder}</strong>
              <span>{entry.reasons.join(" ")}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type Dictionary = Record<string, string>;

const zh: Dictionary = {
  title: "来源命名",
  body: "按 GitHub 仓库身份统一来源命名：文件夹与调用名改为“项目--作者”，项目名在前，界面仍以项目名为主。早期安装的来源没有作者部分，父入口可能和别的作者同名。标题、备注、分类、评分、固定版本和使用记录都会保留。",
  recheck: "重新检查",
  statRename: "可统一",
  statAligned: "已统一",
  statAttention: "需处理",
  selectAll: "全选（{n}）",
  expand: "展开全部",
  collapse: "收起",
  more: "另有 {n} 个，展开查看",
  apply: "统一选中的 {n} 个",
  confirmTitle: "确认统一命名",
  confirmNames: "左侧旧调用名将不再可用，请在 AI 工具中改用右侧新名称。AI 客户端没有可靠的别名机制，因此不会伪造旧名入口。",
  confirmKeep: "只重命名 AI SkillHub 管理的来源文件夹，作者文件内容不变。",
  confirmBackup: "执行前自动备份索引和配置；中断后再次点击会继续完成。",
  confirm: "确认统一 {n} 个",
  applying: "正在统一…",
  cancel: "取消",
  interrupted: "上次命名统一被中断。继续完成后索引才会一致。",
  finish: "继续完成",
  allAligned: "所有 GitHub 来源都已使用“项目--作者”命名。"
};

const en: Dictionary = {
  title: "Source names",
  body: "Source names follow the GitHub repository: folders and invocation names become project--owner, project first, and the interface keeps showing the project name. Sources installed by early versions have no owner part, so their parent name can clash with another author's. Titles, notes, folders, ratings, pins and usage history are kept.",
  recheck: "Check again",
  statRename: "Can unify",
  statAligned: "Unified",
  statAttention: "Needs review",
  selectAll: "Select all ({n})",
  expand: "Show all",
  collapse: "Show less",
  more: "{n} more — show all",
  apply: "Unify {n} selected",
  confirmTitle: "Confirm name unification",
  confirmNames: "The old invocation names on the left stop working; use the new names on the right in your AI tools. Clients have no reliable alias mechanism, so no fake old-name entry is created.",
  confirmKeep: "Only folders managed by AI SkillHub are renamed; the author's files are unchanged.",
  confirmBackup: "The index and config are backed up first; if interrupted, click again to finish.",
  confirm: "Unify {n}",
  applying: "Unifying…",
  cancel: "Cancel",
  interrupted: "The last name unification was interrupted. Finish it to keep the index consistent.",
  finish: "Finish now",
  allAligned: "Every GitHub source already uses project--owner."
};

const ko: Dictionary = {
  title: "소스 이름",
  body: "GitHub 저장소 기준으로 소스 이름을 통일합니다. 폴더와 호출 이름은 프로젝트--작성자 형식이 되고, 화면은 계속 프로젝트 이름을 앞에 보여 줍니다. 초기 버전에서 설치한 소스는 작성자 부분이 없어 다른 작성자와 부모 이름이 겹칠 수 있습니다. 제목, 메모, 폴더, 평점, 버전 고정, 사용 기록은 유지됩니다.",
  recheck: "다시 확인",
  statRename: "통일 가능",
  statAligned: "통일됨",
  statAttention: "확인 필요",
  selectAll: "모두 선택 ({n})",
  expand: "모두 보기",
  collapse: "접기",
  more: "{n}개 더 보기",
  apply: "선택한 {n}개 통일",
  confirmTitle: "이름 통일 확인",
  confirmNames: "왼쪽의 이전 호출 이름은 더 이상 작동하지 않습니다. AI 도구에서 오른쪽 새 이름을 사용하세요. 클라이언트에 믿을 수 있는 별칭 기능이 없어 가짜 이전 이름 항목은 만들지 않습니다.",
  confirmKeep: "AI SkillHub가 관리하는 소스 폴더만 이름을 바꾸며 작성자 파일은 그대로입니다.",
  confirmBackup: "실행 전에 인덱스와 설정을 백업합니다. 중단되면 다시 눌러 완료하세요.",
  confirm: "{n}개 통일",
  applying: "통일하는 중…",
  cancel: "취소",
  interrupted: "지난 이름 통일이 중단되었습니다. 인덱스를 일관되게 하려면 완료하세요.",
  finish: "지금 완료",
  allAligned: "모든 GitHub 소스가 이미 프로젝트--작성자 이름을 사용합니다."
};

const dictionaries: Record<Lang, Dictionary> = { zh, en, ko };

function it(key: string, vars?: Record<string, string | number>) {
  let text = dictionaries[getLang()][key] ?? en[key] ?? key;
  for (const [name, value] of Object.entries(vars ?? {})) text = text.split(`{${name}}`).join(String(value));
  return text;
}

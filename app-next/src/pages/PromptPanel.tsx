// Prompt material in the skill drawer (restored from 3.2.x, lost in the 3.3 rewrite): a
// prompt source is not an installed Skill, so it is used by copy and paste. The panel
// shows which tools are ready, which files go into the copy, lets the person add the
// task, copies the full invocation, opens the folder, and can create a Skill launcher
// that points at the prompt (PromptLauncherAction) for tools that only call Skills.
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Icon } from "../icons";
import { getLang, t } from "../i18n";
import { copyTextToClipboard, hasTauriRuntime, showUiToast } from "../appShared";
import { PromptLauncherAction } from "../PromptLauncherAction";
import type { PromptInvocationCard } from "../types";

const TASK_COPY = {
  zh: { task: "本次任务", placeholder: "说明目标、材料与输出要求…", preview: "查看将复制的完整内容" },
  en: { task: "Your task", placeholder: "Goal, inputs, and expected output…", preview: "Preview copied instructions" },
  ko: { task: "이번 작업", placeholder: "목표, 자료와 출력 요구사항…", preview: "복사할 내용 보기" }
};

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function PromptPanel({ sourceId, onCreated }: {
  sourceId: string;
  onCreated: () => Promise<unknown>;
}) {
  const runtimeAvailable = hasTauriRuntime();
  const [card, setCard] = useState<PromptInvocationCard | null>(null);
  const [error, setError] = useState("");
  const [task, setTask] = useState("");
  const words = TASK_COPY[getLang()] ?? TASK_COPY.zh;

  useEffect(() => {
    if (!runtimeAvailable) return;
    let cancelled = false;
    setCard(null);
    setError("");
    invoke<PromptInvocationCard>("load_prompt_invocation", { sourceId })
      .then(result => { if (!cancelled) setCard(result); })
      .catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; };
  }, [sourceId, runtimeAvailable]);

  if (!runtimeAvailable) {
    return (
      <section className="drawer-notice" data-testid="prompt-panel">
        <Icon name="info" />
        <div>
          <strong>{t("lib.promptNotSkill")}</strong>
          <span>{t("lib.promptMethodBody")}</span>
        </div>
      </section>
    );
  }
  if (error) return <p className="drawer-notice problem">{t("lib.promptLoadFailed", { message: error })}</p>;
  if (!card) return <p className="muted">{t("lib.promptPreparing")}</p>;

  const invocationText = task.trim() ? `${card.copyText}\n\n## ${words.task}\n${task.trim()}` : card.copyText;
  const openFolder = async () => {
    try {
      await invoke("open_prompt_source_folder", { sourceId: card.sourceId });
      showUiToast(t("lib.promptOpened"), "ok");
    } catch (reason) {
      showUiToast(t("lib.promptOpenFailed", { message: reason instanceof Error ? reason.message : String(reason) }), "error");
    }
  };

  return (
    <div className="prompt-panel" data-testid="prompt-panel">
      <section className="drawer-notice">
        <Icon name="info" />
        <div>
          <strong>{t("lib.promptNotSkill")}</strong>
          <span>{t("lib.promptMethodBody")}</span>
        </div>
      </section>
      <section className={`drawer-notice${card.workspaceComplete ? "" : " warn"}`}>
        <Icon name={card.workspaceComplete ? "shield" : "alert"} />
        <div>
          <strong>{card.workspaceComplete ? t("lib.promptWorkspaceComplete") : t("lib.promptWorkspaceIncomplete")}</strong>
          {!card.workspaceComplete && <span>{t("lib.promptReadd")}</span>}
        </div>
      </section>

      {card.hosts.length > 0 && (
        <section className="drawer-block">
          <h4>{t("lib.promptHosts")}</h4>
          <ul className="prompt-list">
            {card.hosts.map(host => (
              <li key={host.id}>
                <i className={`prompt-dot ${host.deliveryStatus === "copy-paste-ready" ? "ok" : "warn"}`} aria-hidden="true" />
                <strong>{host.name}</strong>
                <small>{host.deliveryStatus === "copy-paste-ready" ? t("lib.promptHostReady") : t("lib.promptHostNotReady")}</small>
              </li>
            ))}
          </ul>
        </section>
      )}

      {card.assets.length > 0 && (
        <section className="drawer-block">
          <h4>{t("lib.promptAssets")}</h4>
          <ul className="prompt-list">
            {card.assets.map(asset => (
              <li key={asset.relativePath}>
                <Icon name="list" />
                <strong title={asset.relativePath}>{asset.name}</strong>
                <small>{formatSize(asset.bytes)} · {asset.included ? t("lib.promptIncluded") : t("lib.promptReference")}</small>
              </li>
            ))}
          </ul>
        </section>
      )}

      {card.warnings.length > 0 && (
        <ul className="prompt-warnings">{card.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
      )}

      <section className="prompt-compose">
        <label htmlFor={`prompt-task-${card.sourceId}`}>{words.task}</label>
        <textarea id={`prompt-task-${card.sourceId}`} onChange={event => setTask(event.target.value)} placeholder={words.placeholder} value={task} />
        <details><summary>{words.preview}</summary><pre>{invocationText}</pre></details>
      </section>

      <div className="prompt-actions">
        <button className="primary-action" data-testid="prompt-copy" onClick={() => void copyTextToClipboard(invocationText, t("lib.promptCopied"))} type="button">
          <Icon name="copy" /> {t("lib.promptCopy")}
        </button>
        <button className="secondary-action" onClick={() => void openFolder()} type="button">
          <Icon name="folder" /> {t("lib.promptOpenFolder")}
        </button>
      </div>
      <PromptLauncherAction onCreated={onCreated} sourceId={card.sourceId} />
    </div>
  );
}

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { getLang } from "./i18n";
import { Icon } from "./icons";

export type PromptLauncherResult = { name: string; path: string; warning?: string | null };

const copy = {
  zh: {
    action: "创建 Skill 调用入口", working: "正在创建入口…",
    help: "生成指向原 Prompt 的独立 Skill 入口，原资料保留，不自动执行脚本。",
    created: "调用入口已创建", next: "同步到 AI 工具后可使用此入口；原 Prompt 仍独立保留。",
    failure: "创建未完成，请重试。", refreshFailure: "入口已保留，但列表刷新未完成。请刷新技能库。",
    copyName: "复制名称", copyPath: "复制路径", copied: "已复制", copyFailure: "复制失败，请手动选择名称或路径。",
    details: "查看详情"
  },
  en: {
    action: "Create Skill launcher", working: "Creating launcher…",
    help: "Create a separate Skill pointing to the original Prompt. The source stays intact; scripts do not run automatically.",
    created: "Skill launcher created", next: "Sync it to your AI tools before using it. The original Prompt remains separate.",
    failure: "Creation did not finish. Please retry.", refreshFailure: "The launcher was kept, but the list did not refresh. Refresh your library.",
    copyName: "Copy name", copyPath: "Copy path", copied: "Copied", copyFailure: "Copy failed. Select the name or path manually.",
    details: "Details"
  },
  ko: {
    action: "Skill 호출 항목 만들기", working: "호출 항목 생성 중…",
    help: "원본 Prompt를 가리키는 별도 Skill을 만듭니다. 원본을 유지하며 스크립트는 자동 실행하지 않습니다.",
    created: "Skill 호출 항목 생성됨", next: "AI 도구에 동기화한 후 사용할 수 있습니다. 원본 Prompt는 별도로 유지됩니다.",
    failure: "생성이 완료되지 않았습니다. 다시 시도하세요.", refreshFailure: "호출 항목은 유지되었지만 목록을 갱신하지 못했습니다. 라이브러리를 새로 고치세요.",
    copyName: "이름 복사", copyPath: "경로 복사", copied: "복사됨", copyFailure: "복사하지 못했습니다. 이름이나 경로를 직접 선택하세요.",
    details: "세부 정보"
  }
};

export function PromptLauncherAction({ sourceId, onCreated }: {
  sourceId: string;
  onCreated: () => Promise<unknown>;
}) {
  const text = copy[getLang()];
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PromptLauncherResult | null>(null);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [copied, setCopied] = useState("");
  const generation = useRef(0);
  const inFlight = useRef(false);

  useEffect(() => {
    ++generation.current;
    inFlight.current = false;
    setBusy(false);
    setResult(null);
    setError("");
    setWarning("");
    setCopied("");
    return () => { ++generation.current; };
  }, [sourceId]);

  async function create() {
    if (inFlight.current || !sourceId) return;
    const operation = ++generation.current;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setWarning("");
    try {
      const created = await invoke<PromptLauncherResult>("create_prompt_launcher", { sourceId });
      if (operation !== generation.current) return;
      setResult(created);
      setWarning(created.warning || "");
      try { await onCreated(); }
      catch { if (operation === generation.current) setWarning([created.warning, text.refreshFailure].filter(Boolean).join(" ")); }
    } catch (cause) {
      if (operation === generation.current) setError(String(cause));
    } finally {
      if (operation === generation.current) { inFlight.current = false; setBusy(false); }
    }
  }

  async function copyValue(value: string, kind: string) {
    const operation = generation.current;
    try {
      await navigator.clipboard.writeText(value);
      if (operation === generation.current) setCopied(kind);
    } catch { if (operation === generation.current) setWarning(text.copyFailure); }
  }

  return <section className="prompt-launcher-action" aria-busy={busy}>
    <p>{text.help}</p>
    <button className="secondary-action" disabled={busy || !sourceId} onClick={() => void create()} type="button"><Icon name={busy ? "refresh" : "add"} className={busy ? "icon-spin" : ""} />{busy ? text.working : text.action}</button>
    {result && <div className="prompt-launcher-result" role="status">
      <p><strong>{text.created}</strong></p>
      <p>{text.next}</p>
      <p><code>{result.name}</code> <button className="ghost-action small" onClick={() => void copyValue(result.name, "name")} type="button">{copied === "name" ? text.copied : text.copyName}</button></p>
      <p><code style={{ overflowWrap: "anywhere", whiteSpace: "normal" }}>{result.path}</code> <button className="ghost-action small" onClick={() => void copyValue(result.path, "path")} type="button">{copied === "path" ? text.copied : text.copyPath}</button></p>
    </div>}
    {warning && <p role="status">{warning}</p>}
    {error && <div role="alert"><p>{text.failure}</p><details><summary>{text.details}</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{error}</pre></details></div>}
  </section>;
}

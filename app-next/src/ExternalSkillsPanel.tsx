import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons";
import { externalSkillsText as text, filterExternalSkills, type ExternalAgentSkill, type ExternalAgentSkillInventory } from "./externalSkills";
import "./ExternalSkillsPanel.css";

export function ExternalSkillsPanel({ runtimeAvailable, disabled, onImport }: {
  runtimeAvailable: boolean; disabled: boolean; onImport: (path: string) => void;
}) {
  const [inventory, setInventory] = useState<ExternalAgentSkillInventory | null>(null);
  const [projectPath, setProjectPath] = useState("");
  const [scannedProject, setScannedProject] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [agent, setAgent] = useState("all");
  const [status, setStatus] = useState("all");
  const [limit, setLimit] = useState(60);
  const [detail, setDetail] = useState<{ skill: ExternalAgentSkill; content: string; loading: boolean } | null>(null);
  const [copied, setCopied] = useState("");
  const scanGeneration = useRef(0);
  const readGeneration = useRef(0);
  const detailElement = useRef<HTMLElement | null>(null);

  async function scan(path: string) {
    const generation = ++scanGeneration.current;
    ++readGeneration.current;
    setDetail(null);
    setBusy(true);
    setError("");
    try {
      const next = await invoke<ExternalAgentSkillInventory>("scan_external_agent_skills", { projectPath: path.trim() || null });
      if (scanGeneration.current !== generation) return;
      setInventory(next);
      setAgent(current => next.skills.some(skill => skill.agentId === current) ? current : "all");
      setScannedProject(path.trim());
      setLimit(60);
    } catch (cause) {
      if (scanGeneration.current === generation) setError(String(cause));
    } finally {
      if (scanGeneration.current === generation) setBusy(false);
    }
  }

  useEffect(() => {
    if (runtimeAvailable) void scan("");
    return () => { ++scanGeneration.current; ++readGeneration.current; };
  }, [runtimeAvailable]);

  useEffect(() => {
    if (detail) detailElement.current?.scrollIntoView({ block: "nearest" });
  }, [detail?.skill.id]);

  const filtered = useMemo(() => filterExternalSkills(inventory?.skills ?? [], query, agent, status), [inventory, query, agent, status]);
  const agents = useMemo(() => Array.from(new Map((inventory?.skills ?? []).map(skill => [skill.agentId, skill.agentName]))), [inventory]);

  async function read(skill: ExternalAgentSkill) {
    const generation = ++readGeneration.current;
    setError("");
    setDetail({ skill, content: "", loading: true });
    try {
      const result = await invoke<{ path: string; content: string }>("read_external_agent_skill", { path: skill.path, projectPath: scannedProject || null });
      if (readGeneration.current === generation) setDetail({ skill, content: result.content, loading: false });
    } catch (cause) {
      if (readGeneration.current === generation) { setDetail(null); setError(String(cause)); }
    }
  }

  async function copyPath(skill: ExternalAgentSkill) {
    try { await navigator.clipboard.writeText(skill.path); setCopied(skill.id); }
    catch { setError(text("error")); }
  }

  return <section className="external-skills panel" aria-labelledby="external-skills-title">
    <header className="external-skills-heading">
      <div><h3 id="external-skills-title">{text("title")}</h3><p>{text("body")}</p></div>
      <button className="secondary-action" disabled={!runtimeAvailable || busy || disabled} onClick={() => void scan(projectPath)} type="button"><Icon name="refresh" className={busy ? "icon-spin" : ""} />{text("scan")}</button>
    </header>
    {!runtimeAvailable ? <p className="external-skills-note">{text("preview")}</p> : <>
      <form className="external-skills-project" onSubmit={event => { event.preventDefault(); if (!busy && !disabled) void scan(projectPath); }}>
        <label>{text("project")}<input value={projectPath} placeholder={text("projectHint")} onChange={event => setProjectPath(event.target.value)} /></label>
        <button className="secondary-action" disabled={busy || disabled} type="submit">{text("scanProject")}</button>
      </form>
      <div className="external-skills-filters">
        <input aria-label={text("search")} placeholder={text("search")} value={query} onChange={event => { setQuery(event.target.value); setLimit(60); }} />
        <select aria-label={text("all")} value={agent} onChange={event => { setAgent(event.target.value); setLimit(60); }}><option value="all">{text("all")}</option>{agents.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
        <select aria-label={text("allStatus")} value={status} onChange={event => { setStatus(event.target.value); setLimit(60); }}><option value="all">{text("allStatus")}</option><option value="external">{text("external")}</option><option value="managed">{text("managed")}</option></select>
      </div>
      {busy && <p role="status">{text("scanning")}</p>}
      {error && <div className="external-skills-error" role="alert"><strong>{text("error")}</strong>{inventory && <p>{text("failed")}</p>}<details><summary>{text("roots")}</summary><pre>{error}</pre></details></div>}
      {inventory?.truncated && <p className="external-skills-note" role="status">{text("limited")}</p>}
      {inventory && <>
        <div className="external-skills-summary"><span>{filtered.length} / {inventory.skills.length} {text("found")}</span><span>{text("shown")} {Math.min(limit, filtered.length)}</span></div>
        <p className="external-skills-note">{text("importHelp")}</p>
        <ul className="external-skills-list" aria-busy={busy}>
          {filtered.slice(0, limit).map(skill => <li key={skill.id}>
            <div className="external-skills-item"><div className="external-skills-name"><strong>{skill.name}</strong><span>{skill.agentName}</span><span>{text(skill.scope === "project" ? "projectScope" : "global")}</span><span>{text(skill.storageKind)}</span><span>{text(skill.managed ? "managed" : "external")}</span></div><p>{skill.description}</p><code title={skill.path}>{skill.path}</code></div>
            <div className="external-skills-actions">
              <button className="ghost-action small" disabled={busy} onClick={() => void read(skill)} type="button">{text("details")}</button>
              <button className="ghost-action small" onClick={() => void copyPath(skill)} type="button">{copied === skill.id ? text("copied") : text("copy")}</button>
              <button className="secondary-action small" title={skill.canImport ? text("importHelp") : text("noImport")} disabled={disabled || busy || !skill.canImport} onClick={() => onImport(skill.canonicalPath)} type="button"><Icon name="add" />{text("import")}</button>
            </div>
          </li>)}
        </ul>
        {!filtered.length && !busy && <div className="external-skills-empty"><strong>{text("empty")}</strong><p>{text("emptyBody")}</p></div>}
        {filtered.length > limit && <button className="secondary-action" onClick={() => setLimit(value => value + 60)} type="button">{text("more")}</button>}
        <details className="external-skills-roots"><summary>{text("roots")} ({inventory.roots.length})</summary>{inventory.roots.map((root, index) => <p key={`${root.path}-${index}`}><strong>{root.agentName}</strong> · {root.status} · {root.skillCount}<br /><code>{root.path}</code></p>)}{inventory.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>
      </>}
      {detail && <section ref={detailElement} className="external-skills-detail" aria-live="polite"><header><h4>{detail.skill.name} · {text("original")}</h4><button className="ghost-action" onClick={() => { ++readGeneration.current; setDetail(null); }} type="button">{text("close")}</button></header><pre tabIndex={0}>{detail.loading ? text("reading") : detail.content}</pre></section>}
    </>}
  </section>;
}

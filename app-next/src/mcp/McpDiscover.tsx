// "发现" tab (contract §6.8): the verified Origin recipe (collapsed, detection only on click),
// the built-in templates, and GitHub import. Browsing this tab never starts a process and never
// fetches anything until the user presses a button.
import { useEffect, useState } from "react";
import type { McpAddRequest, McpClientId, McpLibrarySnapshot, McpTemplate, McpTemplateId } from "./mcpTypes";
import { mcpApi } from "./mcpApi";
import { McpRecipeCard } from "../McpRecipeCard";
import type { AddSubmitResult } from "./McpAddSheet";
import { Glyph, Spinner, t } from "./mcpUi";

let templateCache: McpTemplate[] | null = null;

export default function McpDiscover({
  snapshot,
  runtimeAvailable,
  onAddTemplate,
  onGithub,
  onAdd,
  onEnable,
  onOpenUrl,
  onOpenExisting,
  focusRecipe
}: {
  snapshot: McpLibrarySnapshot | null;
  runtimeAvailable: boolean;
  onAddTemplate: (id: McpTemplateId) => void;
  onGithub: (source: string) => Promise<boolean>;
  onAdd: (request: McpAddRequest) => Promise<AddSubmitResult>;
  /** Turns a library server on in more AI tools (the Origin card when origin is already listed). */
  onEnable: (serverId: string, clientIds: McpClientId[]) => Promise<AddSubmitResult>;
  onOpenUrl: (url: string) => void;
  /** Opens the edit drawer of a library server with this name (templates already added). */
  onOpenExisting: (name: string) => void;
  focusRecipe?: boolean;
}) {
  const [templates, setTemplates] = useState<McpTemplate[] | null>(templateCache);
  const [source, setSource] = useState("");
  const [reading, setReading] = useState(false);

  useEffect(() => {
    if (templateCache) return;
    let cancelled = false;
    mcpApi.templates().then(list => {
      templateCache = list;
      if (!cancelled) setTemplates(list);
    }).catch(() => {
      if (!cancelled) setTemplates([]);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (focusRecipe) document.getElementById("mcp-discover-recipes")?.scrollIntoView({ block: "start" });
  }, [focusRecipe]);

  const existing = new Set((snapshot?.servers ?? []).map(row => row.name.toLowerCase()));

  return (
    <div className="mcp-discover">
      <section aria-labelledby="mcp-discover-recipes" className="mcp-discover-section">
        <h3 id="mcp-discover-recipes">{t("mcp.discover.verified")}</h3>
        <p className="mcp-muted small">{t("mcp.discover.verifiedHint")}</p>
        <McpRecipeCard onAdd={onAdd} onEnable={onEnable} runtimeAvailable={runtimeAvailable} snapshot={snapshot} />
      </section>

      <section aria-labelledby="mcp-discover-templates" className="mcp-discover-section">
        <h3 id="mcp-discover-templates">{t("mcp.discover.templates")}</h3>
        {templates === null ? (
          <p className="mcp-muted"><Spinner /> {t("mcp.discover.loading")}</p>
        ) : (
          <ul className="mcp-template-grid">
            {templates.map(template => {
              const added = existing.has(template.id);
              const target = template.input.transport === "stdio"
                ? [template.input.command, ...(template.input.args ?? []).filter(Boolean)].join(" ")
                : template.input.url ?? "";
              return (
                <li className="mcp-template-card" key={template.id}>
                  <div className="mcp-template-head">
                    <strong>{template.id}</strong>
                    {added && <span className="mcp-tag ok">{t("mcp.discover.inLibrary")}</span>}
                  </div>
                  <p>{t(`mcp.template.${template.id}`)}</p>
                  <code title={target}>{target}</code>
                  <div className="mcp-template-meta">
                    {template.runner && <span className="mcp-tag">{t("mcp.discover.needsRunner", { runner: template.runner })}</span>}
                    {template.secrets.some(secret => secret.required) && <span className="mcp-tag warn">{t("mcp.row.needsKey")}</span>}
                    {template.params.length > 0 && <span className="mcp-tag">{t("mcp.discover.needsFolder")}</span>}
                  </div>
                  <div className="mcp-template-actions">
                    {added ? (
                      <button className="mcp-btn small quiet" onClick={() => onOpenExisting(template.id)} type="button">
                        <Glyph name="key" /> {t("mcp.row.edit")}
                      </button>
                    ) : (
                      <button className="mcp-btn small solid" onClick={() => onAddTemplate(template.id)} type="button">
                        <Glyph name="plus" /> {t("mcp.discover.add")}
                      </button>
                    )}
                    <button className="mcp-link" onClick={() => onOpenUrl(template.docsUrl)} type="button">
                      {t("mcp.edit.docs")} <Glyph name="external" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="mcp-discover-github" className="mcp-discover-section">
        <h3 id="mcp-discover-github">{t("mcp.discover.github")}</h3>
        <p className="mcp-muted small">{t("mcp.discover.githubHint")}</p>
        <form
          className="mcp-github-form"
          onSubmit={async event => {
            event.preventDefault();
            if (!source.trim() || reading) return;
            setReading(true);
            try {
              await onGithub(source.trim());
            } finally {
              setReading(false);
            }
          }}
        >
          <label className="sr-only" htmlFor="mcp-github-source">{t("mcp.discover.github")}</label>
          <input
            autoComplete="off"
            id="mcp-github-source"
            onChange={event => setSource(event.target.value)}
            placeholder="owner/repo · https://github.com/owner/repo/tree/main/src/memory"
            spellCheck={false}
            value={source}
          />
          <button className="mcp-btn solid" disabled={!source.trim() || reading} type="submit">
            {reading ? <Spinner /> : <Glyph name="import" />} {t("mcp.discover.githubRead")}
          </button>
        </form>
      </section>
    </div>
  );
}

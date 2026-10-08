// "测试" shows exactly what will run before anything starts (contract §6.6, M1-2).
// The run button is the only path to mcp_test_server; nothing tests on paste, import or browsing.
import { useRef } from "react";
import type { McpTestPreview } from "./mcpTypes";
import { Glyph, Overlay, t } from "./mcpUi";

export function McpTestDialog({
  preview,
  serverName,
  onRun,
  onCancel,
  onFillSecret,
  onOpenGuide
}: {
  preview: McpTestPreview;
  serverName: string;
  onRun: () => void;
  onCancel: () => void;
  onFillSecret: () => void;
  onOpenGuide: (url: string) => void;
}) {
  const runRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const runnerMissing = preview.runner !== null && !preview.runner.found;
  const needsSecret = preview.missingSecrets.length > 0;
  const blocked = runnerMissing || needsSecret;
  return (
    <Overlay initialFocus={blocked ? cancelRef : runRef} label={t("mcp.test.dialogTitle", { name: serverName })} onClose={onCancel} variant="dialog">
      <div className="mcp-dialog-body">
        <div aria-hidden="true" className="mcp-dialog-icon"><Glyph name="play" /></div>
        <h2>{t("mcp.test.dialogTitle", { name: serverName })}</h2>
        {preview.kind === "process" ? (
          <>
            <p className="mcp-test-label">{t("mcp.test.willRun")}</p>
            <code className="mcp-command-block">{preview.commandLine}</code>
            {preview.runner?.found && preview.runner.pathDisplay && (
              <p className="mcp-muted small">{t("mcp.test.runnerAt", { runner: preview.runner.name, path: preview.runner.pathDisplay })}</p>
            )}
            <p>{t("mcp.test.processExplain", { seconds: preview.timeoutSeconds })}</p>
          </>
        ) : (
          <>
            <p className="mcp-test-label">{t("mcp.test.willConnect")}</p>
            <code className="mcp-command-block">{preview.url}</code>
            <p>{t("mcp.test.httpExplain", { seconds: preview.timeoutSeconds })}</p>
          </>
        )}
        {runnerMissing && preview.runner && (
          <div className="mcp-callout warn" role="alert">
            <Glyph name="warn" />
            <span>{t("mcp.test.runnerMissing", { runner: preview.runner.name })}</span>
            {preview.runner.installHint && (
              <button className="mcp-btn small quiet" onClick={() => onOpenGuide(preview.runner?.installHint?.url ?? "")} type="button">
                {t("mcp.test.installGuide")} <Glyph name="external" />
              </button>
            )}
          </div>
        )}
        {needsSecret && (
          <div className="mcp-callout warn" role="alert">
            <Glyph name="key" />
            <span>{t("mcp.test.needsSecretFirst", { names: preview.missingSecrets.join(t("mcp.list.sep")) })}</span>
            <button className="mcp-btn small quiet" onClick={onFillSecret} type="button">{t("mcp.row.fill")}</button>
          </div>
        )}
      </div>
      <footer className="mcp-dialog-foot">
        <button className="mcp-btn quiet" onClick={onCancel} ref={cancelRef} type="button">{t("mcp.common.cancel")}</button>
        <button className="mcp-btn solid" disabled={blocked} onClick={onRun} ref={runRef} type="button">
          <Glyph name="play" /> {t("mcp.test.run")}
        </button>
      </footer>
    </Overlay>
  );
}

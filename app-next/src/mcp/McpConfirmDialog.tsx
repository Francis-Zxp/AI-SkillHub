// Plain-language confirmation (contract §6.7). Shown only for the I6 cases the backend reports as
// `needs-confirmation`; every string goes through i18n, never backend tokens (bug MCP#13).
import { useRef, useState } from "react";
import type { McpClient, McpConfirmation, McpConfirmationItem, McpConfirmationKind } from "./mcpTypes";
import { clientLabel, clientNames, joinNames } from "./mcpLogic";
import { Glyph, Overlay, t } from "./mcpUi";

export type ConfirmAnswer = { token: string; deleteEnvVars: string[] };

const VERB: Record<McpConfirmationKind, string> = {
  "remove-from-library": "mcp.confirm.verb.delete",
  "remove-from-client": "mcp.confirm.verb.delete",
  "overwrite-different": "mcp.confirm.verb.overwrite",
  "changed-outside": "mcp.confirm.verb.overwrite",
  rollback: "mcp.confirm.verb.undo",
  "overwrite-env-var": "mcp.confirm.verb.overwrite",
  "delete-env-var": "mcp.confirm.verb.delete",
  "inline-secret": "mcp.confirm.verb.write",
  resync: "mcp.confirm.verb.rewrite"
};

const KIND_ORDER: McpConfirmationKind[] = [
  "remove-from-library", "remove-from-client", "rollback", "inline-secret", "overwrite-env-var",
  "delete-env-var", "changed-outside", "overwrite-different", "resync"
];

export function primaryKind(confirmation: McpConfirmation): McpConfirmationKind {
  return KIND_ORDER.find(kind => confirmation.kinds.includes(kind)) ?? confirmation.kinds[0] ?? "resync";
}

function vars(confirmation: McpConfirmation, clients: readonly McpClient[]) {
  const items = confirmation.items;
  const first = items[0];
  const servers = [...new Set(items.map(item => item.serverName).filter(Boolean))];
  const clientIds = [...new Set(items.map(item => item.clientId))];
  const envNames = (confirmation.envVars ?? []).map(item => item.name);
  const secretNames = envNames.length > 0
    ? envNames
    : [...new Set(items.flatMap(item => [...(item.after?.envNames ?? []), ...(item.after?.headerNames ?? [])]))];
  return {
    server: joinNames(servers, t) || t("mcp.word.thisServer"),
    client: first ? clientLabel(first.clientId, clients) : t("mcp.word.aiTool"),
    clients: clientIds.length > 0 ? clientNames(clientIds, t, clients) : t("mcp.word.aiTool"),
    names: joinNames(secretNames, t) || t("mcp.word.apiKey"),
    name: envNames[0] ?? ""
  };
}

function fieldWords(item: McpConfirmationItem) {
  return item.changedFields.map(field => t(`mcp.field.${field}`)).join(t("mcp.list.sep"));
}

export function ItemLine({ item, clients }: { item: McpConfirmationItem; clients: readonly McpClient[] }) {
  const sign = item.action === "remove" || item.action === "disable" ? "−" : item.action === "add" || item.action === "enable" ? "+" : "↺";
  const target = item.after?.targetDisplay ?? item.before?.targetDisplay ?? "";
  return (
    <li className={`mcp-confirm-item action-${item.action}`}>
      <span aria-hidden="true" className="mcp-confirm-sign">{sign}</span>
      <div>
        <strong>
          {t("mcp.confirm.itemHead", {
            client: item.clientLabel || clientLabel(item.clientId, clients),
            action: t(`mcp.action.${item.action}`),
            server: item.serverName
          })}
          {item.projectLabel ? <em> · {item.projectLabel}</em> : null}
        </strong>
        {item.before && item.after && item.before.targetDisplay !== item.after.targetDisplay ? (
          <span className="mcp-confirm-diff">
            {t("mcp.confirm.beforeAfter", { before: item.before.targetDisplay, after: item.after.targetDisplay })}
          </span>
        ) : target ? (
          <span className="mcp-confirm-diff">{target}</span>
        ) : null}
        {item.changedFields.length > 0 && <span className="mcp-confirm-fields">{t("mcp.confirm.fields", { fields: fieldWords(item) })}</span>}
      </div>
    </li>
  );
}

export function McpConfirmDialog({
  confirmation,
  clients,
  onAnswer
}: {
  confirmation: McpConfirmation;
  clients: readonly McpClient[];
  onAnswer: (answer: ConfirmAnswer | null) => void;
}) {
  const kind = primaryKind(confirmation);
  const values = vars(confirmation, clients);
  const deletable = (confirmation.envVars ?? []).filter(item => item.action === "delete" && item.createdBySkillHub);
  const [deleteEnv, setDeleteEnv] = useState<string[]>([]);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const danger = kind === "remove-from-library" || kind === "remove-from-client";
  return (
    <Overlay initialFocus={cancelRef} label={t(`mcp.confirm.${kind}.title`, values)} onClose={() => onAnswer(null)} variant="dialog">
      <div className="mcp-dialog-body">
        <div className={`mcp-dialog-icon ${danger ? "danger" : "warn"}`} aria-hidden="true">
          <Glyph name={danger ? "warn" : kind === "rollback" ? "undo" : "flag"} />
        </div>
        <h2>{t(`mcp.confirm.${kind}.title`, values)}</h2>
        <p>{t(`mcp.confirm.${kind}.body`, values)}</p>
        {confirmation.items.length > 0 && (
          <ul className="mcp-confirm-list">
            {confirmation.items.map((item, index) => (
              <ItemLine clients={clients} item={item} key={`${item.clientId}-${item.serverName}-${index}`} />
            ))}
          </ul>
        )}
        {(confirmation.envVars ?? []).filter(item => item.action === "set").map(item => (
          <p className="mcp-confirm-note" key={item.name}>{t("mcp.confirm.envExists", { name: item.name })}</p>
        ))}
        {deletable.length > 0 && (
          <fieldset className="mcp-confirm-env">
            {deletable.map(item => (
              <label key={item.name}>
                <input
                  checked={deleteEnv.includes(item.name)}
                  onChange={event =>
                    setDeleteEnv(current => (event.target.checked ? [...current, item.name] : current.filter(name => name !== item.name)))
                  }
                  type="checkbox"
                />
                {t("mcp.confirm.deleteEnv", { name: item.name })}
              </label>
            ))}
          </fieldset>
        )}
        {!confirmation.undoable && <p className="mcp-confirm-note warn">{t("mcp.confirm.notUndoable")}</p>}
      </div>
      <footer className="mcp-dialog-foot">
        <button className="mcp-btn quiet" onClick={() => onAnswer(null)} ref={cancelRef} type="button">{t("mcp.common.cancel")}</button>
        <button
          className={danger ? "mcp-btn solid danger" : "mcp-btn solid"}
          onClick={() => onAnswer({ token: confirmation.confirmToken, deleteEnvVars: deleteEnv })}
          type="button"
        >
          {t(VERB[kind])}
        </button>
      </footer>
    </Overlay>
  );
}

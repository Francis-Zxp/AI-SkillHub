// Agents (clients) page. Split out of App.tsx;
// App() still owns the shared state and handlers. Never import from App.tsx here (use appShared.ts).
import { Suspense, lazy } from "react";
import { Icon } from "../icons";
import { t } from "../i18n";
import { externalSkillsText } from "../externalSkills";
import type { LegacySnapshot } from "../types";
import { copyTextToClipboard } from "../appShared";
import { DeferredSurface } from "../components/ui";

const ExternalSkillsPanel = lazy(() => import("../ExternalSkillsPanel").then(module => ({ default: module.ExternalSkillsPanel })));
const CodexPluginDoctorPanel = lazy(() =>
  import("../CodexPluginDoctorPanel").then(module => ({ default: module.CodexPluginDoctorPanel }))
);

export function Agents({
  disabled,
  onImportLocalSkill,
  onRefreshAgents,
  onConnectAgents,
  runtimeAvailable,
  snapshot
}: {
  disabled: boolean;
  onImportLocalSkill: (path: string) => void;
  onRefreshAgents: () => void;
  onConnectAgents: () => void;
  runtimeAvailable: boolean;
  snapshot: LegacySnapshot | null;
}) {
  const adapters = snapshot?.agentAdapters ?? [];
  const doctors = snapshot?.agentDoctors ?? [];
  const capabilities = snapshot?.adapterCapabilities ?? [];
  const safetyChecks = snapshot?.adapterSafetyChecks ?? [];
  const enabledSkillCount = snapshot?.skills.filter(skill => skill.enabled).length ?? 0;
  const sharedSkillsDirectory = adapters.find(adapter => adapter.id === "coze")?.skillsPathHint ?? "";
  return (
    <div className="view agents-view">
      <section className="page-header glow-card">
        <div>
          <span className="eyebrow"><Icon name="agent" /> {t("nav.agents")}</span>
          <h2>{t("agents.title")}</h2>
          <p>{t("agents.subtitle")}</p>
        </div>
        <div className="page-header-side">
          <div className="page-header-stats">
            <span>{t("agents.supported", { n: adapters.length })}</span>
            <span>{t("agents.detected", { n: adapters.filter(adapter => adapter.detected).length })}</span>
            <span>{t("agents.enabled", { n: adapters.filter(adapter => adapter.enabled).length })}</span>
          </div>
          <button className="secondary-action" disabled={disabled} onClick={onRefreshAgents} type="button">
            <Icon className={disabled ? "icon-spin" : ""} name="refresh" /> {disabled ? t("agents.detecting") : t("agents.detectNow")}
          </button>
          <button className="primary-action" disabled={disabled || !runtimeAvailable} onClick={onConnectAgents} type="button">
            <Icon name="connections" /> {t("agents.connectNow")}
          </button>
        </div>
      </section>

      <Suspense fallback={<DeferredSurface label={externalSkillsText("scanning")} />}>
        <ExternalSkillsPanel disabled={disabled} onImport={onImportLocalSkill} runtimeAvailable={runtimeAvailable} />
      </Suspense>

      <section className="panel glow-card">
        <header className="panel-head">
          <div>
            <span className="eyebrow">{t("agents.registryEyebrow")}</span>
            <h3>{t("agents.registryTitle")}</h3>
            <p>{t("agents.registryBody")}</p>
          </div>
        </header>
        {enabledSkillCount > 200 && (
          <p className="agent-catalog-warning"><Icon name="info" /> {t("agents.largeCatalog", { n: enabledSkillCount })}</p>
        )}
      </section>

      <Suspense fallback={<DeferredSurface label={t("pluginDoctor.scanning")} />}>
        <CodexPluginDoctorPanel runtimeAvailable={runtimeAvailable} />
      </Suspense>

      <div className="adapter-grid">
        {adapters.map(adapter => {
          const doctor = doctors.find(item => item.adapterId === adapter.id);
          return (
          <article className="adapter-card glow-card" key={adapter.id}>
            <header>
              <strong>{adapter.name}</strong>
              <span className={`adapter-status ${adapter.status}`}>{adapterStatusLabel(adapter.status)}</span>
            </header>
            <p>{adapter.id === "coze" ? t("agents.cozeDirectoryLabel") : adapter.skillsPathHint || t("agents.noPath")}</p>
            {adapter.id === "claude" && <p className="adapter-note">{t("agents.claudeSkillsNote")}</p>}
            {adapter.id === "workbuddy" && <p className="adapter-note">{t("agents.workbuddySkillsNote")}</p>}
            {adapter.id === "coze" && (
              <div className="adapter-note">
                <p>{t("agents.cozeSkillsNote")}</p>
                <p>{sharedSkillsDirectory}</p>
                <button className="secondary-action" disabled={!runtimeAvailable || !sharedSkillsDirectory} onClick={() => void copyTextToClipboard(sharedSkillsDirectory, t("agents.cozeFolderCopied"))} type="button">
                  <Icon name="copy" /> {t("agents.cozeCopyDirectory")}
                </button>
              </div>
            )}
            {!["claude", "codex", "antigravity", "workbuddy", "coze"].includes(adapter.id) && <p className="adapter-note">{t("agents.inventoryOnlyNote")}</p>}
            {doctor && (
              <div className={`adapter-doctor verdict-${doctor.verdict}`}>
                <header>
                  <strong>{t("doctor.title")}</strong>
                  <span className="doctor-verdict">{doctorVerdictLabel(doctor.verdict)}</span>
                </header>
                <p>{doctor.summary}</p>
                <dl>
                  <div><dt>{t("doctor.desktop")}</dt><dd className={`doctor-state state-${doctor.desktopStatus}`}>{doctorStatusLabel(doctor.desktopStatus)}</dd></div>
                  <div><dt>{t("doctor.cli")}</dt><dd className={`doctor-state state-${doctor.cliStatus}`}>{doctorStatusLabel(doctor.cliStatus)}</dd></div>
                  <div><dt>{t("doctor.skills")}</dt><dd className={`doctor-state state-${doctor.skillsStatus}`}>{doctorStatusLabel(doctor.skillsStatus)}</dd></div>
                </dl>
                {(doctor.evidence.length > 0 || doctor.nextSteps.length > 0) && (
                  <details>
                    <summary>{t("doctor.evidence")}</summary>
                    <ul>
                      {doctor.evidence.slice(0, 6).map((item, index) => (
                        <li className={`doctor-evidence status-${item.status}`} key={`${item.probeKind}-${item.label}-${index}`}>
                          <strong>{item.label}</strong>
                          <span>{item.detail}{item.path ? ` · ${item.path}` : ""}</span>
                        </li>
                      ))}
                      {doctor.nextSteps.map((step, index) => (
                        <li className="doctor-next-step" key={`next-${index}`}>{step}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
            <ul className="capabilities">
              {capabilities
                .filter(capability => capability.adapterId === adapter.id)
                .slice(0, 4)
                .map(capability => (
                  <li className={capability.enabled ? "is-on" : ""} key={capability.id}>
                    {capabilityLabel(capability.capabilityKey)}
                  </li>
                ))}
            </ul>
            <ul className="safety">
              {safetyChecks
                .filter(check => check.adapterId === adapter.id)
                .slice(0, 3)
                .map(check => (
                  <li className={`safety-item ${check.status}`} key={check.id}>{check.summary}</li>
                ))}
            </ul>
            <footer>
              <span>{adapter.vendor}</span>
              <span>{adapter.detected ? t("agents.detectedFlag") : t("agents.notDetectedFlag")}</span>
              <span className={`readonly-badge ${adapter.managed ? "is-managed" : ""}`}>
                {adapter.id === "coze" && adapter.detected ? t("agents.cozeManualSetup") : adapter.managed ? t("agents.managed") : adapter.detected ? t(["claude", "codex", "antigravity", "workbuddy"].includes(adapter.id) ? "agents.pendingSync" : "agents.inventoryOnly") : t("agents.notDetectedFlag")}
              </span>
            </footer>
          </article>
          );
        })}
      </div>
    </div>
  );
}

function adapterStatusLabel(status: string) {
  if (status === "ready") return t("agents.statusReady");
  if (status === "detected-unmanaged") return t("agents.statusUnmanaged");
  return t("agents.statusMissing");
}

function doctorVerdictLabel(verdict: string) {
  if (verdict === "ready") return t("doctor.ready");
  if (verdict === "code-detected") return t("doctor.codeDetected");
  if (verdict === "desktop-only") return t("doctor.desktopOnly");
  if (verdict === "path-refresh-needed") return t("doctor.pathRefresh");
  if (verdict === "directory-residue") return t("doctor.directoryResidue");
  return t("doctor.notDetected");
}

function doctorStatusLabel(status: string) {
  const key = `doctor.status.${status}`;
  const translated = t(key);
  return translated === key ? status : translated;
}

function capabilityLabel(key: string) {
  if (key === "global-scope") return t("agents.capGlobal");
  if (key === "project-scope") return t("agents.capProject");
  if (key === "copy-fallback") return t("agents.capCopy");
  if (key === "instructions-generation") return t("agents.capInstructions");
  return key;
}

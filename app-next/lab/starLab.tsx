// Development fixture: the star map with a library the size of a real one
// (about 56 sources, 900 Skills, 7 folders). /lab/star-lab.html?theme=sky-day
import { createRoot } from "react-dom/client";
import { SkillUniverse } from "../src/SkillUniverse";
import { createPreviewSnapshot } from "../src/preview";
import { setLang } from "../src/i18n";
import "../src/styles.css";

setLang("zh");
const params = new URLSearchParams(location.search);
const theme = params.get("theme") ?? "sky-dusk";
const light = theme === "sky-day";
const base = createPreviewSnapshot();
const folders = ["01文献调研、idea类", "02实操跑代码类", "03paper写作类", "04科研绘图类", "05学术报告/前端UI", "其它工具"];
const colors = ["teal", "blue", "amber", "rose", "violet", "slate"];
const repos = ["skills", "awesome-claude-skills", "scientific-writer", "paper-polish", "figure-kit", "agent-tools", "research-flow", "ui-craft", "data-lab", "latex-helper", "web-design", "prompt-lib", "nature-paper-skills", "superpowers", "browser-use", "mcp-builder"];
const owners = ["anthropics", "obra", "karpathy", "openai", "zhangsan", "lab-x", "vercel", "emilkowalski", "wanglab", "deepmind"];
const sources = Array.from({ length: 56 }, (_, index) => {
  const repo = repos[index % repos.length];
  const owner = owners[(index * 7) % owners.length];
  const folder = index % 9 === 8 ? null : index % folders.length;
  return {
    ...base.sources[0],
    id: `source-${index}`,
    name: `${repo}--${owner}`,
    url: `https://github.com/${owner}/${repo}`,
    enabled: index % 13 !== 5,
    userFolderId: folder === null ? "" : `folder-${folder}`
  };
});
const skills = sources.flatMap((source, sourceIndex) => {
  const count = 4 + ((sourceIndex * 37) % 28);
  const folder = source.userFolderId ? Number(source.userFolderId.split("-")[1]) : -1;
  const router = { ...base.skills[0], id: `router-${sourceIndex}`, name: source.name, folderName: source.name, sourceId: source.id, source: source.name, isRouterHub: true, rating: 3, userFolderId: source.userFolderId, userFolderName: folder >= 0 ? folders[folder] : undefined, userFolderColor: folder >= 0 ? colors[folder] : undefined };
  const children = Array.from({ length: count }, (_, index) => ({
    ...base.skills[0],
    id: `skill-${sourceIndex}-${index}`,
    name: `${["write", "review", "plot", "search", "debug", "format", "cite", "translate"][index % 8]}-${["paper", "figure", "code", "notes", "slides", "data"][(index + sourceIndex) % 6]}-${index}`,
    folderName: `skill-${index}`,
    sourceId: source.id,
    source: source.name,
    isRouterHub: false,
    enabled: (index + sourceIndex) % 11 !== 0,
    rating: (index * 3 + sourceIndex) % 6,
    health: (index + sourceIndex) % 17 === 0 ? "warn" as const : "ok" as const,
    userFolderId: source.userFolderId,
    userFolderName: folder >= 0 ? folders[folder] : undefined,
    userFolderColor: folder >= 0 ? colors[folder] : undefined
  }));
  return [router, ...children];
});
const snapshot = {
  ...base,
  sources,
  skills,
  skillFolders: folders.map((name, index) => ({ id: `folder-${index}`, name, color: colors[index], sortOrder: index, note: "", skillCount: 0, createdAt: "", updatedAt: "" }))
};
document.body.style.margin = "0";
createRoot(document.getElementById("root")!).render(
  <div className={`shell theme-${theme} theme-family-atlas page-dashboard`} style={{ height: "100vh", display: "block" }}>
    <div className="dashboard-view" style={{ height: "100vh" }}>
      <section className="dashboard-hero intro-collapsed" style={{ position: "relative", width: "100vw", height: "100vh" }}>
        <SkillUniverse centered lightTheme={light} tone="sky" snapshot={snapshot as never} onOpenSkill={() => undefined} onOpenSource={() => undefined} />
      </section>
    </div>
  </div>
);
setTimeout(() => { document.body.dataset.ready = "1"; }, 1500);

// Development trial for the sky world: renders realistic category data in a
// chosen direction for screenshots. /lab/sky-trial.html?dir=morning&set=real
import { createSkyWorld } from "../src/sky/world";

const params = new URLSearchParams(location.search);
const direction = params.get("dir") ?? "noon";
const set = params.get("set") ?? "real";
const sets: Record<string, Array<{ id: string; name: string; weight: number }>> = {
  real: [
    { id: "f01", name: "01文献调研、idea类", weight: 186 },
    { id: "f02", name: "02实操跑代码类", weight: 64 },
    { id: "f03", name: "03paper写作类", weight: 262 },
    { id: "f04", name: "04科研绘图类", weight: 121 },
    { id: "f05", name: "05学术报告/前端UI", weight: 214 },
    { id: "f06", name: "其它工具", weight: 37 },
    { id: "unfiled", name: "未归档", weight: 33 }
  ],
  few: [
    { id: "a", name: "Paper 写作", weight: 3 },
    { id: "b", name: "文献调研 / Idea", weight: 0 },
    { id: "c", name: "图片绘制", weight: 0 },
    { id: "d", name: "软件与 UI", weight: 1 },
    { id: "unfiled", name: "未归档", weight: 1 }
  ],
  many: Array.from({ length: 24 }, (_, index) => ({ id: `m${index}`, name: ["写作", "调研", "代码", "绘图", "数据", "UI 设计", "工具", "翻译"][index % 8] + ` ${index + 1}`, weight: Math.round(Math.abs(Math.sin(index * 1.7)) * 200) }))
};
const islands = sets[set] ?? sets.real;
const host = document.getElementById("host")!;
if (direction === "night") document.body.classList.add("dark");
const labels = new Map<string, HTMLElement>();
for (const island of islands) {
  const label = document.createElement("button");
  label.className = "label";
  label.innerHTML = `<strong>${island.name}</strong><span>${island.weight} Skills</span>`;
  host.appendChild(label);
  labels.set(island.id, label);
}
const started = performance.now();
createSkyWorld({
  host,
  islands,
  labels,
  direction,
  paused: params.get("paused") === "1",
  lowPower: params.get("low") === "1",
  onOpen: id => console.log("open", id),
  onHover: () => undefined,
  onFailure: reason => console.error("failure", reason)
}).then(world => {
  const ready = performance.now() - started;
  (window as unknown as { skyWorld: typeof world }).skyWorld = world;
  if (params.get("focus")) world.focus(params.get("focus"));
  setTimeout(() => {
    const stats = world.stats();
    document.getElementById("stats")!.textContent = `${direction} · ready ${Math.round(ready)}ms · ${JSON.stringify(stats)}`;
    document.body.dataset.ready = "1";
    document.body.dataset.stats = JSON.stringify({ ...stats, readyMs: Math.round(ready) });
  }, 2500);
}).catch(error => {
  console.error(error);
  document.getElementById("stats")!.textContent = `error: ${error}`;
  document.body.dataset.ready = "1";
});

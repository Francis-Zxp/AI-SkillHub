type LabelView = {
  element: HTMLDivElement;
  title: HTMLSpanElement;
  owner: HTMLSpanElement;
  appearance: string;
  visible: boolean;
};

/** Persistent text surfaces move with the nodes without re-rasterizing glyphs each frame. */
export class UniverseLabelLayer {
  private views = new Map<string, LabelView>();
  private shown = new Set<string>();

  constructor(private host: HTMLDivElement) {}

  begin() { this.shown.clear(); }

  place(id: string, title: string, owner: string, x: number, y: number, width: number,
    height: number, size: number, weight: number, opacity: number, focused: boolean,
    color: string, halo: string, chip: string, border: string) {
    let view = this.views.get(id);
    if (!view) {
      const element = document.createElement("div");
      const titleElement = document.createElement("span");
      const ownerElement = document.createElement("span");
      element.className = "skill-universe-label";
      element.dataset.nodeId = id;
      ownerElement.className = "skill-universe-label-owner";
      element.append(titleElement, ownerElement);
      this.host.append(element);
      view = { element, title: titleElement, owner: ownerElement, appearance: "", visible: false };
      this.views.set(id, view);
    }
    this.shown.add(id);
    const appearance = JSON.stringify([title, owner, width, height, size, weight, focused, color, halo, chip, border]);
    if (view.appearance !== appearance) {
      view.appearance = appearance;
      view.title.textContent = title;
      view.owner.textContent = owner;
      Object.assign(view.element.style, {
        width: `${width}px`, height: `${height}px`, fontSize: `${size}px`, fontWeight: String(weight),
        padding: `0 ${focused ? 9 : 3}px`, color,
        background: focused ? chip : "transparent",
        boxShadow: focused ? `inset 0 0 0 1px ${border}` : "none",
        textShadow: focused ? "none" : `0 1px 2px ${halo}`
      });
    }
    view.element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    view.element.style.opacity = String(opacity);
    view.visible = true;
  }

  end() {
    for (const [id, view] of this.views) {
      if (this.shown.has(id)) continue;
      if (view.visible) { view.element.style.opacity = "0"; view.visible = false; }
      // Keep common labels cached, but don't retain every child ever hovered.
      if (this.views.size > 64) { view.element.remove(); this.views.delete(id); }
    }
  }

  clear() { this.host.replaceChildren(); this.views.clear(); this.shown.clear(); }
}

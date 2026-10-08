type LabelView = {
  element: HTMLDivElement;
  title: HTMLSpanElement;
  owner: HTMLSpanElement;
  /** What was last written, so an unchanged label costs nothing. */
  text: string;
  ownerText: string;
  width: number;
  height: number;
  size: number;
  weight: number;
  focused: boolean;
  color: string;
  halo: string;
  chip: string;
  border: string;
  x: number;
  y: number;
  opacity: number;
  visible: boolean;
};

/** Persistent text surfaces move with the nodes without re-rasterizing glyphs each frame.
 * Runs every frame: it compares fields instead of building strings, and writes a
 * style only when it changed. */
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
      view = {
        element, title: titleElement, owner: ownerElement, text: "", ownerText: "", width: -1, height: -1, size: -1, weight: -1,
        focused: false, color: "", halo: "", chip: "", border: "", x: Number.NaN, y: Number.NaN, opacity: -1, visible: false
      };
      this.views.set(id, view);
    }
    this.shown.add(id);
    if (view.text !== title) { view.text = title; view.title.textContent = title; }
    if (view.ownerText !== owner) { view.ownerText = owner; view.owner.textContent = owner; }
    if (view.width !== width || view.height !== height || view.size !== size || view.weight !== weight || view.focused !== focused ||
      view.color !== color || view.halo !== halo || view.chip !== chip || view.border !== border) {
      Object.assign(view, { width, height, size, weight, focused, color, halo, chip, border });
      Object.assign(view.element.style, {
        width: `${width}px`, height: `${height}px`, fontSize: `${size}px`, fontWeight: String(weight),
        padding: `0 ${focused ? 9 : 3}px`, color,
        background: focused ? chip : "transparent",
        boxShadow: focused ? `inset 0 0 0 1px ${border}` : "none",
        textShadow: focused ? "none" : `0 1px 2px ${halo}`
      });
    }
    // Sub-pixel moves below a twentieth of a pixel are invisible.
    if (Math.abs(view.x - x) > 0.05 || Math.abs(view.y - y) > 0.05 || Number.isNaN(view.x)) {
      view.x = x;
      view.y = y;
      view.element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    }
    if (Math.abs(view.opacity - opacity) > 0.004) {
      view.opacity = opacity;
      view.element.style.opacity = String(opacity);
    }
    view.visible = true;
  }

  end() {
    for (const [id, view] of this.views) {
      if (this.shown.has(id)) continue;
      if (view.visible) { view.element.style.opacity = "0"; view.visible = false; view.opacity = 0; }
      // Keep common labels cached, but don't retain every child ever hovered.
      if (this.views.size > 64) { view.element.remove(); this.views.delete(id); }
    }
  }

  clear() { this.host.replaceChildren(); this.views.clear(); this.shown.clear(); }
}

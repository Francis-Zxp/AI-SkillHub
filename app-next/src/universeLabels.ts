export type LabelState = { side: number; opacity: number; blockedSince: number; updatedAt: number };

/** Keep a label on its current side through brief occlusions, then fade before moving. */
export function advanceLabel(state: LabelState, available: boolean[], now: number, reducedMotion = false) {
  const elapsed = Math.min(64, Math.max(0, now - state.updatedAt));
  state.updatedAt = now;
  if (available[state.side]) state.blockedSince = 0;
  else if (!state.blockedSince) state.blockedSince = now || 1;
  const blocked = !available[state.side] && now - state.blockedSince >= 160;
  const target = available[state.side] || (!blocked && state.opacity > 0) ? 1 : 0;
  state.opacity = reducedMotion ? target : Math.max(0, Math.min(1, state.opacity + (target ? 1 : -1) * elapsed / 180));
  if (state.opacity <= 0.01 && !available[state.side]) {
    const next = available.findIndex(Boolean);
    if (next >= 0) { state.side = next; state.blockedSince = 0; }
  }
  return state;
}

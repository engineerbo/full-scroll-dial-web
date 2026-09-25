/**
 * Computes the position of a range slider thumb as a percentage (0–100).
 * Returns `fallback` when the span is zero to avoid division by zero.
 */
export function thumbPct(
  value: number,
  absMin: number,
  absMax: number,
  fallback: number
): number {
  const span = absMax - absMin;
  return span > 0 ? ((value - absMin) / span) * 100 : fallback;
}

/**
 * Produces the CSS `calc(...)` string that positions a floating thumb label
 * so it stays centred over the thumb at any position across the track.
 *
 * At 0% the label is nudged right by one thumb radius; at 100% it is nudged
 * left by one thumb radius; at 50% the offset is zero.
 */
export function thumbOffsetCss(pct: number, thumbRadiusPx: number): string {
  return `calc(${pct}% + ${thumbRadiusPx * (1 - (2 * pct) / 100)}px)`;
}

/**
 * Sets the `--range-min-pct` and `--range-max-pct` CSS custom properties on
 * `track` to drive the blue fill between the two thumbs.
 *
 * Returns the computed percentages so the caller can use them for label
 * positioning without recomputing.
 */
export function applyRangeTrackFill(
  track: HTMLElement,
  minValue: number,
  maxValue: number,
  absMin: number,
  absMax: number
): { minPct: number; maxPct: number } {
  const minPct = thumbPct(minValue, absMin, absMax, 0);
  const maxPct = thumbPct(maxValue, absMin, absMax, 100);
  track.style.setProperty('--range-min-pct', `${minPct}%`);
  track.style.setProperty('--range-max-pct', `${maxPct}%`);
  return { minPct, maxPct };
}

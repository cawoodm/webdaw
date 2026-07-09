/**
 * Pure timeline math for the Arrange tab — Tone-free so it stays unit-testable.
 * Positions and spans are fractional BARS; snap sizes are BEATS (4 beats/bar).
 */

export const PX_PER_BAR_STEPS = [4, 6, 8, 12, 16, 24, 32, 48, 64];

export const SNAP_BEATS: { beats: number; label: string }[] = [
  { beats: 0, label: 'Snap: none' },
  { beats: 4, label: 'Snap: 4 beats' },
  { beats: 2, label: 'Snap: 2 beats' },
  { beats: 1, label: 'Snap: 1 beat' },
  { beats: 0.5, label: 'Snap: 1/2' },
  { beats: 0.25, label: 'Snap: 1/4' },
  { beats: 0.125, label: 'Snap: 1/8' },
  { beats: 0.0625, label: 'Snap: 1/16' },
  { beats: 0.03125, label: 'Snap: 1/32' },
];

export function floorSnapBar(bar: number, snapBeats: number): number {
  if (snapBeats <= 0) return bar;
  const snapBars = snapBeats / 4;
  return Math.floor(bar / snapBars + 1e-9) * snapBars;
}

export function nearestSnapBar(bar: number, snapBeats: number): number {
  if (snapBeats <= 0) return bar;
  const snapBars = snapBeats / 4;
  return Math.round(bar / snapBars) * snapBars;
}

/** Smallest span a resize may reach: one snap unit, or 1/32 bar when snapping is off. */
export function minSpanBars(snapBeats: number): number {
  return snapBeats > 0 ? snapBeats / 4 : 1 / 32;
}

const BAR_TICK_STEPS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];

/** Bars between ruler labels so labels stay >=44px apart at the given zoom. */
export function pickBarTick(pxPerBar: number): number {
  for (const step of BAR_TICK_STEPS) {
    if (step * pxPerBar >= 44) return step;
  }
  return BAR_TICK_STEPS[BAR_TICK_STEPS.length - 1];
}

/**
 * Hierarchical vertical gridlines: bar heaviest, then halving levels down to
 * the snap unit — the bar-based twin of sequence-tab's gridBackgroundSteps,
 * but sized in px because arrange rows have a fixed px width per bar.
 * Levels narrower than 5px are dropped so a zoomed-out grid never turns solid.
 */
export function gridBackgroundBars(pxPerBar: number, snapBeats: number): { image: string; size: string } {
  const style = (level: number): { w: number; a: number } =>
    [
      { w: 2, a: 0.6 }, // bar
      { w: 1, a: 0.32 }, // 1/2 bar
      { w: 1, a: 0.2 }, // beat
      { w: 1, a: 0.12 }, // finer
    ][Math.min(level, 3)];
  const snapBars = snapBeats > 0 ? snapBeats / 4 : 1;
  const images: string[] = [];
  const sizes: string[] = [];
  for (let bars = 1, level = 0; bars >= snapBars - 1e-9; bars /= 2, level++) {
    const px = bars * pxPerBar;
    if (px < 5) break;
    const { w, a } = style(level);
    images.push(`linear-gradient(90deg, rgb(148 163 184 / ${a * 100}%) ${w}px, transparent ${w}px)`);
    sizes.push(`${px}px 100%`);
  }
  return { image: images.join(', '), size: sizes.join(', ') };
}

/** The bar range worth having clip DOM for, given the scroll window plus a buffer. */
export function visibleBarRange(
  scrollLeft: number,
  viewWidth: number,
  pxPerBar: number,
  totalBars: number,
  bufferPx = 200,
): { from: number; to: number } {
  const from = Math.max(0, Math.floor((scrollLeft - bufferPx) / pxPerBar));
  const to = Math.min(totalBars, Math.ceil((scrollLeft + viewWidth + bufferPx) / pxPerBar));
  return { from, to };
}

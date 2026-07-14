/**
 * Pure timeline math for the Arrange tab — Tone-free so it stays unit-testable.
 * Positions and spans are fractional BARS; snap sizes are BEATS (4 beats/bar).
 */

import type { ClipLoopMode, PadEvent } from '../../core/model';

export const PX_PER_BAR_STEPS = [4, 6, 8, 12, 16, 24, 32, 48, 64];

export const SNAP_BEATS: { beats: number; label: string }[] = [
  { beats: 0, label: 'none' },
  { beats: 4, label: '4 beats' },
  { beats: 2, label: '2 beats' },
  { beats: 1, label: '1 beat' },
  { beats: 0.5, label: '1/2' },
  { beats: 0.25, label: '1/4' },
  { beats: 0.125, label: '1/8' },
  { beats: 0.0625, label: '1/16' },
  { beats: 0.03125, label: '1/32' },
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

export interface ClipCursorWindow {
  /** Clip ends at/before the cursor — nothing of it plays from here. */
  skip: boolean;
  /** Beats already elapsed into the clip before the cursor (0 unless the cursor lands inside the clip). */
  skipBeats: number;
}

/**
 * How a clip's bar span relates to a playback cursor at `fromBar` (both in bars).
 * `fromBar <= 0` always yields the no-op window (today's behavior). A clip that
 * ends at/before the cursor is fully skipped; one starting at/after the cursor
 * plays unshifted (skipBeats 0); one the cursor lands inside reports how many
 * beats of it have already elapsed.
 */
export function clipCursorWindow(clipBar: number, spanBars: number, fromBar: number): ClipCursorWindow {
  if (fromBar <= 0) return { skip: false, skipBeats: 0 };
  if (clipBar + spanBars <= fromBar) return { skip: true, skipBeats: 0 };
  return { skip: false, skipBeats: Math.max(0, (fromBar - clipBar) * 4) };
}

export interface TiledLoopEvent {
  pad: number;
  offsetBeats: number;
  duration?: number;
}

/**
 * Tile a Beat's pad events across a clip span: iteration k shifts every
 * event by k*loopBeats. Events starting at/past the span edge are dropped
 * whole — never truncated — so hits keep their natural tails and repeat
 * crossovers stay click-free.
 */
export function tileLoopEvents(events: PadEvent[], loopBeats: number, spanBeats: number): TiledLoopEvent[] {
  if (loopBeats <= 0 || spanBeats <= 0) return [];
  const out: TiledLoopEvent[] = [];
  for (let k = 0; k * loopBeats < spanBeats - 1e-9; k++) {
    for (const ev of events) {
      const offsetBeats = k * loopBeats + ev.time;
      if (offsetBeats < spanBeats - 1e-9) out.push({ pad: ev.pad, offsetBeats, duration: ev.duration });
    }
  }
  return out;
}

export interface BufferLoopStart {
  /** Seconds after the (cursor-adjusted) clip start at which this source starts. */
  at: number;
  /** Offset into the buffer, in BUFFER seconds (nonzero only when the cursor lands inside this repetition). */
  offset: number;
  /** Output seconds until the source is stopped. */
  stopAfter: number;
}

export interface BufferLoopPlan {
  playbackRate: number; // 1 for gapless/bar
  loop: boolean; // true for gapless/resample
  starts: BufferLoopStart[];
}

/**
 * How a file/pad clip stretched past its natural length repeats its buffer.
 * `skipBeats` is the play-cursor offset into the clip (0 when playback starts
 * at/before the clip). See docs/superpowers/specs/2026-07-13-clip-repeat-design.md.
 */
export function bufferLoopPlan(
  mode: ClipLoopMode,
  durationSeconds: number,
  barSeconds: number,
  spanBars: number,
  skipBeats: number,
): BufferLoopPlan {
  const skipSeconds = (skipBeats / 4) * barSeconds;
  const spanSeconds = spanBars * barSeconds;
  const remaining = spanSeconds - skipSeconds;

  if (mode === 'resample') {
    const targetBars = Math.max(1, Math.round(durationSeconds / barSeconds));
    const periodSeconds = targetBars * barSeconds;
    const playbackRate = durationSeconds / periodSeconds;
    if (remaining <= 0) return { playbackRate, loop: true, starts: [] };
    return {
      playbackRate,
      loop: true,
      starts: [{ at: 0, offset: (skipSeconds % periodSeconds) * playbackRate, stopAfter: remaining }],
    };
  }

  if (mode === 'bar') {
    if (remaining <= 0) return { playbackRate: 1, loop: false, starts: [] };
    const naturalBars = Math.max(1, Math.ceil(durationSeconds / barSeconds - 1e-9));
    const periodSeconds = naturalBars * barSeconds;
    const starts: BufferLoopStart[] = [];
    for (let k = 0; k * periodSeconds < spanSeconds - 1e-9; k++) {
      const repStart = k * periodSeconds;
      const repPlay = Math.min(durationSeconds, spanSeconds - repStart);
      if (repStart + repPlay <= skipSeconds) continue;
      if (repStart < skipSeconds) {
        starts.push({ at: 0, offset: skipSeconds - repStart, stopAfter: repPlay - (skipSeconds - repStart) });
      } else {
        starts.push({ at: repStart - skipSeconds, offset: 0, stopAfter: repPlay });
      }
    }
    return { playbackRate: 1, loop: false, starts };
  }

  // 'gapless'
  if (remaining <= 0) return { playbackRate: 1, loop: true, starts: [] };
  return {
    playbackRate: 1,
    loop: true,
    starts: [{ at: 0, offset: skipSeconds % durationSeconds, stopAfter: remaining }],
  };
}

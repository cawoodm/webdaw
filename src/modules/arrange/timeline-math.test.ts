import { describe, expect, it } from 'vitest';
import {
  bufferLoopPlan,
  clipCursorWindow,
  floorSnapBar,
  gridBackgroundBars,
  minSpanBars,
  nearestSnapBar,
  pickBarTick,
  tileLoopEvents,
  visibleBarRange,
} from './timeline-math';

describe('snap', () => {
  it('floor-snaps a bar position to the snap grid (snap in beats, 4 beats per bar)', () => {
    expect(floorSnapBar(2.7, 4)).toBe(2); // whole-bar snap
    expect(floorSnapBar(2.7, 1)).toBe(2.5); // 1-beat snap = quarter bar
    expect(floorSnapBar(2.7, 0.5)).toBe(2.625); // half-beat snap = 1/8 bar
  });
  it('nearest-snaps for resize', () => {
    expect(nearestSnapBar(2.7, 1)).toBe(2.75);
    expect(nearestSnapBar(2.55, 1)).toBe(2.5);
  });
  it('snap 0 means free movement', () => {
    expect(floorSnapBar(2.712, 0)).toBe(2.712);
    expect(nearestSnapBar(2.712, 0)).toBe(2.712);
  });
  it('minimum clip span is one snap unit, or 1/32 bar when free', () => {
    expect(minSpanBars(1)).toBe(0.25);
    expect(minSpanBars(0)).toBe(1 / 32);
  });
});

describe('pickBarTick', () => {
  it('labels every bar when zoomed in, sparser when zoomed out (>=44px between labels)', () => {
    expect(pickBarTick(64)).toBe(1);
    expect(pickBarTick(16)).toBe(4);
    expect(pickBarTick(4)).toBe(16);
  });
});

describe('visibleBarRange', () => {
  it('converts scroll window to a clamped, buffered bar range', () => {
    expect(visibleBarRange(0, 320, 16, 800, 0)).toEqual({ from: 0, to: 20 });
    expect(visibleBarRange(160, 320, 16, 800, 160)).toEqual({ from: 0, to: 40 });
    expect(visibleBarRange(12640, 320, 16, 800, 0)).toEqual({ from: 790, to: 800 });
  });
});

describe('gridBackgroundBars', () => {
  it('produces one gradient layer per level from bar down to the snap unit', () => {
    const g = gridBackgroundBars(64, 1); // bar, half-bar, beat
    expect(g.image.split('linear-gradient').length - 1).toBe(3);
    expect(g.size.split(',').map((s) => s.trim())).toEqual(['64px 100%', '32px 100%', '16px 100%']);
  });
  it('drops levels finer than 5px so a zoomed-out grid never turns solid', () => {
    // pxPerBar 8, snap 1/4 beat: half-bar would be 4px — only the 8px bar level survives
    expect(gridBackgroundBars(8, 0.25).size).toBe('8px 100%');
  });
});

describe('clipCursorWindow', () => {
  it('is a no-op when there is no cursor (fromBar <= 0)', () => {
    expect(clipCursorWindow(2, 4, 0)).toEqual({ skip: false, skipBeats: 0 });
    expect(clipCursorWindow(2, 4, -1)).toEqual({ skip: false, skipBeats: 0 });
  });
  it('skips a clip that ends at/before the cursor', () => {
    expect(clipCursorWindow(2, 2, 4)).toEqual({ skip: true, skipBeats: 0 }); // ends exactly at cursor
    expect(clipCursorWindow(2, 1, 4)).toEqual({ skip: true, skipBeats: 0 }); // ends before cursor
  });
  it('plays unshifted when the clip starts at/after the cursor', () => {
    expect(clipCursorWindow(4, 2, 4)).toEqual({ skip: false, skipBeats: 0 }); // starts exactly at cursor
    expect(clipCursorWindow(5, 2, 4)).toEqual({ skip: false, skipBeats: 0 }); // starts after cursor
  });
  it('reports elapsed beats when the cursor lands inside the clip', () => {
    expect(clipCursorWindow(2, 4, 4)).toEqual({ skip: false, skipBeats: 8 }); // 2 bars = 8 beats elapsed
    expect(clipCursorWindow(0, 4, 1)).toEqual({ skip: false, skipBeats: 4 });
  });
});

describe('tileLoopEvents', () => {
  const events = [
    { pad: 0, time: 0 },
    { pad: 1, time: 7.5, duration: 0.5 },
  ];

  it('repeats events across an exact multiple of the loop', () => {
    expect(tileLoopEvents(events, 8, 16)).toEqual([
      { pad: 0, offsetBeats: 0, duration: undefined },
      { pad: 1, offsetBeats: 7.5, duration: 0.5 },
      { pad: 0, offsetBeats: 8, duration: undefined },
      { pad: 1, offsetBeats: 15.5, duration: 0.5 },
    ]);
  });

  it('drops events past a fractional span edge instead of truncating', () => {
    // 2-bar loop stretched to 3 bars: second iteration's 7.5-beat hit (offset 15.5) is outside 12 beats
    expect(tileLoopEvents(events, 8, 12).map((t) => t.offsetBeats)).toEqual([0, 7.5, 8]);
  });

  it('keeps only events inside a span shorter than one loop', () => {
    expect(tileLoopEvents(events, 8, 4).map((t) => t.offsetBeats)).toEqual([0]);
  });

  it('returns nothing for empty events or a degenerate loop/span', () => {
    expect(tileLoopEvents([], 8, 16)).toEqual([]);
    expect(tileLoopEvents(events, 0, 16)).toEqual([]);
    expect(tileLoopEvents(events, 8, 0)).toEqual([]);
  });
});

describe('bufferLoopPlan', () => {
  it('gapless: one looping source spanning the whole clip when there is no cursor skip', () => {
    const plan = bufferLoopPlan('gapless', 2.6, 2, 3, 0);
    expect(plan.playbackRate).toBe(1);
    expect(plan.loop).toBe(true);
    expect(plan.starts).toEqual([{ at: 0, offset: 0, stopAfter: 6 }]);
  });

  it('gapless: cursor inside the second pass offsets into the buffer', () => {
    const plan = bufferLoopPlan('gapless', 2.6, 2, 3, 6);
    expect(plan.starts).toHaveLength(1);
    expect(plan.starts[0].at).toBe(0);
    expect(plan.starts[0].offset).toBeCloseTo(0.4, 10);
    expect(plan.starts[0].stopAfter).toBe(3);
  });

  it('bar: repeats every natural-bar period, each full-length', () => {
    const plan = bufferLoopPlan('bar', 2.6, 2, 6, 0);
    expect(plan.playbackRate).toBe(1);
    expect(plan.loop).toBe(false);
    expect(plan.starts).toEqual([
      { at: 0, offset: 0, stopAfter: 2.6 },
      { at: 4, offset: 0, stopAfter: 2.6 },
      { at: 8, offset: 0, stopAfter: 2.6 },
    ]);
  });

  it('bar: last repetition truncated at the span edge', () => {
    const plan = bufferLoopPlan('bar', 2.6, 2, 4.5, 0);
    expect(plan.starts).toEqual([
      { at: 0, offset: 0, stopAfter: 2.6 },
      { at: 4, offset: 0, stopAfter: 2.6 },
      { at: 8, offset: 0, stopAfter: 1 },
    ]);
  });

  it('bar: cursor mid-repetition skips past repetitions and offsets into the current one', () => {
    const plan = bufferLoopPlan('bar', 2.6, 2, 6, 10); // skipSeconds 5
    expect(plan.starts).toEqual([
      { at: 0, offset: 1, stopAfter: 1.6 },
      { at: 3, offset: 0, stopAfter: 2.6 },
    ]);
  });

  it('resample: rounds the target bar count down and up', () => {
    const down = bufferLoopPlan('resample', 2.6, 2, 3, 0);
    expect(down.playbackRate).toBe(1.3);
    expect(down.loop).toBe(true);

    const up = bufferLoopPlan('resample', 3.5, 2, 3, 0);
    expect(up.playbackRate).toBe(0.875);
  });

  it('returns an empty-starts plan once the cursor consumes the whole remaining span', () => {
    expect(bufferLoopPlan('gapless', 2.6, 2, 3, 12).starts).toEqual([]);
    expect(bufferLoopPlan('bar', 2.6, 2, 3, 12).starts).toEqual([]);
    expect(bufferLoopPlan('resample', 2.6, 2, 3, 12).starts).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  floorSnapBar,
  gridBackgroundBars,
  minSpanBars,
  nearestSnapBar,
  pickBarTick,
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

import { describe, it, expect, vi } from 'vitest';
import { thumbPct, thumbOffsetCss, applyRangeTrackFill } from '../range-track';

describe('thumbPct', () => {
  it('returns 0% at the minimum value', () => {
    expect(thumbPct(1, 1, 255, 0)).toBe(0);
  });

  it('returns 100% at the maximum value', () => {
    expect(thumbPct(255, 1, 255, 0)).toBe(100);
  });

  it('returns ~50% at the midpoint', () => {
    // midpoint of [1, 255] is 128; (128-1)/(255-1)*100 ≈ 50
    expect(thumbPct(128, 1, 255, 0)).toBeCloseTo(50, 0);
  });

  it('returns the fallback when span is zero', () => {
    expect(thumbPct(100, 100, 100, 42)).toBe(42);
  });

  it('returns the fallback of 0 for min thumb in zero-span case', () => {
    expect(thumbPct(50, 50, 50, 0)).toBe(0);
  });

  it('returns the fallback of 100 for max thumb in zero-span case', () => {
    expect(thumbPct(50, 50, 50, 100)).toBe(100);
  });
});

describe('thumbOffsetCss', () => {
  const R = 8; // thumb radius used in production

  it('nudges right by one radius at 0%', () => {
    // pct=0 → offset = R*(1 - 0) = R
    expect(thumbOffsetCss(0, R)).toBe(`calc(0% + ${R}px)`);
  });

  it('has zero offset at 50%', () => {
    // pct=50 → offset = R*(1 - 1) = 0
    expect(thumbOffsetCss(50, R)).toBe(`calc(50% + 0px)`);
  });

  it('nudges left by one radius at 100%', () => {
    // pct=100 → offset = R*(1 - 2) = -R
    expect(thumbOffsetCss(100, R)).toBe(`calc(100% + ${-R}px)`);
  });

  it('produces a different string for a different radius', () => {
    expect(thumbOffsetCss(0, 4)).toBe('calc(0% + 4px)');
  });
});

describe('applyRangeTrackFill', () => {
  function makeTrack() {
    const props = new Map<string, string>();
    return {
      element: {
        style: {
          setProperty: vi.fn((k: string, v: string) => props.set(k, v)),
        },
      } as unknown as HTMLElement,
      props,
    };
  }

  it('sets --range-min-pct and --range-max-pct on the track', () => {
    const { element, props } = makeTrack();
    applyRangeTrackFill(element, 1, 255, 1, 255);
    expect(props.get('--range-min-pct')).toBe('0%');
    expect(props.get('--range-max-pct')).toBe('100%');
  });

  it('returns the computed minPct and maxPct', () => {
    const { element } = makeTrack();
    const { minPct, maxPct } = applyRangeTrackFill(element, 1, 255, 1, 255);
    expect(minPct).toBe(0);
    expect(maxPct).toBe(100);
  });

  it('computes percentages correctly for interior values', () => {
    const { element } = makeTrack();
    // absMin=0, absMax=100: min=25 → 25%, max=75 → 75%
    const { minPct, maxPct } = applyRangeTrackFill(element, 25, 75, 0, 100);
    expect(minPct).toBe(25);
    expect(maxPct).toBe(75);
  });

  it('uses fallback 0 for minPct and 100 for maxPct when span is zero', () => {
    const { element, props } = makeTrack();
    const { minPct, maxPct } = applyRangeTrackFill(element, 50, 50, 50, 50);
    expect(minPct).toBe(0);
    expect(maxPct).toBe(100);
    expect(props.get('--range-min-pct')).toBe('0%');
    expect(props.get('--range-max-pct')).toBe('100%');
  });
});

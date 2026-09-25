// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderDfuSteps } from '../dfu-steps';

const EXPECTED_LABELS = [
  '1 · Power off',
  '2 · Hold button',
  '3 · Plug in USB-C',
  '4 · Blue LED → Bootloader mode',
];

describe('renderDfuSteps', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('populates the container with HTML content', () => {
    renderDfuSteps(container);
    expect(container.innerHTML).not.toBe('');
  });

  it('renders exactly 4 step elements', () => {
    renderDfuSteps(container);
    const steps = container.querySelectorAll('[aria-label^="Step "]');
    expect(steps).toHaveLength(4);
  });

  it('renders steps with correct aria-labels', () => {
    renderDfuSteps(container);
    const steps = container.querySelectorAll<HTMLElement>(
      '[aria-label^="Step "]'
    );
    const labels = [...steps].map((el) => el.getAttribute('aria-label'));
    expect(labels).toEqual([
      'Step 1 of 4',
      'Step 2 of 4',
      'Step 3 of 4',
      'Step 4 of 4',
    ]);
  });

  it('renders each step with the correct label text', () => {
    renderDfuSteps(container);
    const steps = container.querySelectorAll<HTMLElement>(
      '[aria-label^="Step "]'
    );
    const texts = [...steps].map((el) => el.textContent?.trim());
    expect(texts).toEqual(EXPECTED_LABELS);
  });

  it('renders exactly 4 animated dot indicators', () => {
    renderDfuSteps(container);
    const dots = container.querySelectorAll('[class*="animate-dfu-dot-"]');
    expect(dots).toHaveLength(4);
  });

  it('replaces existing content on re-render', () => {
    container.innerHTML = '<p id="old">old content</p>';
    renderDfuSteps(container);
    expect(container.querySelector('#old')).toBeNull();
    expect(container.querySelectorAll('[aria-label^="Step "]')).toHaveLength(4);
  });
});

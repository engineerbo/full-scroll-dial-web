// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';
import { infoTip } from '../info-tip';

describe('infoTip()', () => {
  it('links the icon button to its tooltip and renders the text', () => {
    const host = document.createElement('div');
    host.innerHTML = infoTip('fooInfo', 'Explains foo.');

    const button = host.querySelector('button.info-tip-icon')!;
    const tooltip = host.querySelector('[role="tooltip"]')!;

    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('aria-label')).toBe('More info');
    expect(button.getAttribute('aria-describedby')).toBe('fooInfo');
    expect(tooltip.id).toBe('fooInfo');
    expect(tooltip.textContent).toBe('Explains foo.');
  });

  it('renders markup such as a list inside the tooltip', () => {
    const host = document.createElement('div');
    host.innerHTML = infoTip('barInfo', '<ul><li>One</li><li>Two</li></ul>');

    const items = host.querySelectorAll('[role="tooltip"] li');
    expect(Array.from(items, (li) => li.textContent)).toEqual(['One', 'Two']);
  });
});

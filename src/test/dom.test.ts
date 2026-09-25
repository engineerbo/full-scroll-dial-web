// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { getRequiredElement } from '../dom';

describe('getRequiredElement', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns the matching element with correct type', () => {
    document.body.innerHTML = '<button id="connectBtn"></button>';
    const el = getRequiredElement<HTMLButtonElement>('connectBtn');
    expect(el).toBeInstanceOf(HTMLButtonElement);
    expect(el.id).toBe('connectBtn');
  });

  it('throws with the missing id when element is not found', () => {
    expect(() => getRequiredElement('connectBtn')).toThrow(
      'Required element #connectBtn not found'
    );
  });

  it('finds elements nested deep in the document', () => {
    document.body.innerHTML =
      '<div><section><span id="deepEl"></span></section></div>';
    const el = getRequiredElement<HTMLSpanElement>('deepEl');
    expect(el.tagName).toBe('SPAN');
  });
});

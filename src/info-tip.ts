/**
 * Returns the HTML for an ⓘ icon that reveals `html` on hover or keyboard focus.
 * `html` is trusted markup (plain text or e.g. a `<ul>`), never user input.
 * Pure CSS (see `.info-tip` in styles.css); `id` must be unique on the page.
 */
export function infoTip(id: string, html: string): string {
  return `<div class="info-tip">
      <button type="button" class="info-tip-icon" aria-label="More info" aria-describedby="${id}">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" />
          <path d="M8 7.25v4" stroke-linecap="round" />
          <circle cx="8" cy="4.9" r="0.5" fill="currentColor" stroke="none" />
        </svg>
      </button>
      <div id="${id}" role="tooltip" class="info-tip-bubble">${html}</div>
    </div>`;
}

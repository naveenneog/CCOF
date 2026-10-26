// After a failed Continue or Save, focus goes to the first invalid field, or to the error summary when the
// problem has no single field (ADMIN-8), so keyboard and screen-reader users land on what needs fixing
// (WCAG 2.2 technique G139, "a mechanism that allows users to jump to errors":
// https://www.w3.org/WAI/WCAG22/Techniques/general/G139).
interface Focusable { focus(options?: { preventScroll?: boolean }): void }
interface Root { querySelector(selector: string): Focusable | null }

export function focusFirstInvalid(root: Root | null): boolean {
  const target = root?.querySelector('[aria-invalid="true"], [data-invalid="true"]') ?? root?.querySelector("[data-error-summary]") ?? null;
  if (!target) return false;
  target.focus();
  return true;
}

// The errors render on the next frame; focus only once they are in the document.
export function focusFirstInvalidSoon(root: () => Root | null): void {
  setTimeout(() => focusFirstInvalid(root()), 0);
}

/** Shared modal lifetime. Portalled sheets are body siblings, so a nested
 *  sheet can isolate its parent without inheriting the parent's inert state. */
interface Modal {
  id: symbol;
  parent: symbol | null;
  backdrop: HTMLElement;
  dialog: HTMLElement;
  close: () => void;
  launcher: HTMLElement | null;
}
const stack: Modal[] = [];
const isolated = new Map<HTMLElement, { inert: string | null; hidden: string | null }>();
let observer: MutationObserver | null = null;
const bodyStyles = new Map<string, { value: string; priority: string }>();
let scrollX = 0;
let scrollY = 0;
let rootLauncher: HTMLElement | null = null;

function top(): Modal | undefined { return stack[stack.length - 1]; }
function restoreIsolation(): void {
  for (const [node, state] of isolated) {
    if (state.inert === null) node.removeAttribute("inert");
    else node.setAttribute("inert", state.inert);
    if (state.hidden === null) node.removeAttribute("aria-hidden");
    else node.setAttribute("aria-hidden", state.hidden);
  }
  isolated.clear();
}
function isolate(): void {
  restoreIsolation();
  const active = top();
  if (active === undefined) return;
  for (const node of document.body.children) {
    if (!(node instanceof HTMLElement) || node === active.backdrop) continue;
    isolated.set(node, { inert: node.getAttribute("inert"), hidden: node.getAttribute("aria-hidden") });
    node.setAttribute("inert", "");
    node.setAttribute("aria-hidden", "true");
  }
  for (const [index, modal] of stack.entries()) {
    modal.backdrop.style.setProperty("--sheet-layer", String(index));
    if (modal === active) modal.dialog.setAttribute("aria-modal", "true");
    else modal.dialog.removeAttribute("aria-modal");
  }
}
function usable(node: HTMLElement): boolean {
  return node.isConnected && !node.closest('[inert], [hidden], [aria-hidden="true"]') &&
    !node.matches(":disabled") && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
}
function controls(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex], [contenteditable="true"], summary')]
    .filter((node) => node.tabIndex >= 0 && usable(node));
}
function focusDialog(modal: Modal): void { modal.dialog.focus({ preventScroll: true }); }
function onFocus(event: FocusEvent): void {
  const active = top();
  if (active && !active.dialog.contains(event.target as Node)) focusDialog(active);
}
function onKey(event: KeyboardEvent): void {
  const active = top();
  if (!active || event.isComposing) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopImmediatePropagation();
    active.close();
    return;
  }
  if (event.key !== "Tab") return;
  const nodes = controls(active.dialog);
  const current = document.activeElement;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (!first || !last) {
    event.preventDefault();
    focusDialog(active);
  } else if (event.shiftKey && (current === first || !nodes.includes(current as HTMLElement))) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && (current === last || !nodes.includes(current as HTMLElement))) {
    event.preventDefault(); first.focus();
  }
}

export function isTopSheet(backdrop: HTMLElement | null): boolean { return backdrop !== null && top()?.backdrop === backdrop; }

export function openModal(id: symbol, parent: symbol | null, backdrop: HTMLElement, dialog: HTMLElement, close: () => void): () => void {
  const launcher = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (stack.length === 0) {
    rootLauncher = launcher;
    scrollX = window.scrollX;
    scrollY = window.scrollY;
    // Fixed body also prevents background touch-scrolling on iOS; restore
    // its exact inline declarations and scroll position after the last sheet.
    for (const [property, value] of Object.entries({ overflow: "hidden", position: "fixed", top: `${-scrollY}px`, left: `${-scrollX}px`, width: "100%" })) {
      bodyStyles.set(property, { value: document.body.style.getPropertyValue(property), priority: document.body.style.getPropertyPriority(property) });
      document.body.style.setProperty(property, value);
    }
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocus, true);
    observer = new MutationObserver(isolate);
    observer.observe(document.body, { childList: true });
  }
  const modal: Modal = { id, parent, backdrop, dialog, close, launcher };
  // Child layout effects can run before the parent's. Preserve hierarchy
  // even when both mount together: the child remains the active layer.
  const childIndex = stack.findIndex((entry) => entry.parent === id);
  if (childIndex < 0) stack.push(modal);
  else stack.splice(childIndex, 0, modal);
  // Move focus before hiding the previous focused background from AT.
  if (top() === modal) focusDialog(modal);
  isolate();
  return () => {
    const wasTop = top() === modal;
    const index = stack.indexOf(modal);
    if (index < 0) return;
    stack.splice(index, 1);
    isolate();
    if (stack.length === 0) {
      observer?.disconnect(); observer = null;
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocus, true);
      for (const [property, state] of bodyStyles) {
        if (state.value === "") document.body.style.removeProperty(property);
        else document.body.style.setProperty(property, state.value, state.priority);
      }
      bodyStyles.clear();
      window.scrollTo(scrollX, scrollY);
      if (rootLauncher && usable(rootLauncher)) rootLauncher.focus({ preventScroll: true });
      rootLauncher = null;
    } else if (wasTop) {
      const active = top()!;
      if (launcher && active.dialog.contains(launcher) && usable(launcher)) launcher.focus({ preventScroll: true });
      else focusDialog(active);
    }
  };
}

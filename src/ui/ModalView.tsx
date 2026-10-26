/** Shared modal views, isolated from inventory/store initialization. */
import { createContext, type ComponentChildren } from "preact";
import { useContext, useLayoutEffect, useRef } from "preact/hooks";
import { createPortal } from "preact/compat";
import { isTopSheet, openModal } from "./modal";

const SheetParent = createContext<symbol | null>(null);

/** Item details cover the screen and must isolate the controls behind them.
 *  Child sheets share the same modal stack and retain their own focus scope. */
export function ItemOverlay(props: { title: string; onClose: () => void; children: ComponentChildren }) {
  const id = useRef(Symbol("item-details"));
  const parent = useContext(SheetParent);
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(props.onClose);
  close.current = props.onClose;
  useLayoutEffect(() => {
    if (dialog.current === null) return;
    return openModal(id.current, parent, dialog.current, dialog.current, () => close.current());
  }, [parent]);
  return createPortal(
    <SheetParent.Provider value={id.current}>
      <div ref={dialog} class="overlay" role="dialog" aria-modal="true" aria-label={props.title} tabIndex={-1}>
        <header class="screen-head overlay-head">
          <button class="back-btn" type="button" onClick={props.onClose}>‹ Back</button>
          <div class="screen-title">{props.title}</div>
        </header>
        {props.children}
      </div>
    </SheetParent.Provider>, document.body,
  );
}

export function Sheet(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  children?: ComponentChildren;
}) {
  const id = useRef(Symbol("sheet"));
  const parent = useContext(SheetParent);
  const backdrop = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(props.onClose);
  close.current = props.onClose;
  useLayoutEffect(() => {
    if (!props.open || backdrop.current === null || dialog.current === null) return;
    return openModal(id.current, parent, backdrop.current, dialog.current, () => close.current());
  }, [props.open, parent]);
  if (!props.open) return null;
  return createPortal(
    <SheetParent.Provider value={id.current}><div ref={backdrop} class="sheet-backdrop" onClick={(event) => {
      if (event.target === event.currentTarget && isTopSheet(backdrop.current)) props.onClose();
    }}>
      {/* stopPropagation: a tap inside the sheet must not count as a backdrop
          tap and dismiss it */}
      <div ref={dialog} class="sheet" role="dialog" aria-modal="true" aria-label={props.title} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div class="sheet-head">
          <div class="sheet-title">{props.title}</div>
          <button class="sheet-close" type="button" aria-label="Close" onClick={props.onClose}>
            ✕
          </button>
        </div>
        {props.children}
      </div>
    </div></SheetParent.Provider>, document.body,
  );
}

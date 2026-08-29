/**
 * UI context: store access, doc subscription, navigation, toasts.
 * Plain .ts on purpose — providers are built with h() so this file stays
 * JSX-free. All UI state here is ephemeral by design: navigation and toasts
 * must NOT persist (PLAN.md §5 — no launch-state memory; the 3-second answer
 * is decided at cold launch).
 */
import { createContext, h, type ComponentChildren } from "preact";
import { useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AmbryDoc } from "../types";
import type { Store } from "../store/store";

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const StoreCtx = createContext<Store | null>(null);

export function StoreProvider(props: { store: Store; children: ComponentChildren }) {
  return h(StoreCtx.Provider, { value: props.store }, props.children);
}

/** The Store — the ONLY write path (AGENTS.md rule 1). */
export function useStore(): Store {
  const store = useContext(StoreCtx);
  if (store === null) throw new Error("useStore() outside <StoreProvider>");
  return store;
}

/**
 * The live document, re-rendering this component on every committed store
 * mutation. NOTE: the store mutates the doc in place, so the returned
 * reference is stable across renders — read fields fresh each render and do
 * not memoize on doc identity.
 */
export function useDoc(): AmbryDoc {
  const store = useStore();
  const [, setTick] = useState(0);
  useEffect(() => store.subscribe(() => setTick((t) => t + 1)), [store]);
  return store.getDoc();
}

// ---------------------------------------------------------------------------
// Navigation (no router — a tab switch plus two overlays is the whole app)
// ---------------------------------------------------------------------------

export type View = "pantry" | "shopping" | "more" | "reconcile";

/** Context seeds for the quick-create sheet — where the user is standing
 *  when they create (PLAN.md §4 M1: quick create preselects a location). */
export interface CreateDefaults {
  /** Preselected location; null/omitted = none (the "elsewhere" bucket). */
  location?: string | null;
}

export interface Nav {
  view: View;
  /** Switching views also closes the item overlay and the create sheet. */
  setView(v: View): void;
  /** Item detail overlay; null = closed. */
  openItemId: string | null;
  openItem(id: string): void;
  closeItem(): void;
  /** Quick-create sheet; prefill is the typed-but-unmatched search text. */
  creating: boolean;
  createPrefill: string | null;
  createDefaults: CreateDefaults | null;
  openCreate(prefill: string | null, defaults?: CreateDefaults): void;
  closeCreate(): void;
}

const NavCtx = createContext<Nav | null>(null);

export function NavProvider(props: { children: ComponentChildren }) {
  const [view, setViewState] = useState<View>("pantry");
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createPrefill, setCreatePrefill] = useState<string | null>(null);
  const [createDefaults, setCreateDefaults] = useState<CreateDefaults | null>(null);

  const nav = useMemo<Nav>(
    () => ({
      view,
      setView: (v: View) => {
        // Tab switches reset overlays: predictable, no stacked navigation
        // state to leak between tabs.
        setOpenItemId(null);
        setCreating(false);
        setCreatePrefill(null);
        setCreateDefaults(null);
        setViewState(v);
      },
      openItemId,
      openItem: (id: string) => setOpenItemId(id),
      closeItem: () => setOpenItemId(null),
      creating,
      createPrefill,
      createDefaults,
      openCreate: (prefill: string | null, defaults?: CreateDefaults) => {
        setCreatePrefill(prefill);
        setCreateDefaults(defaults ?? null);
        setCreating(true);
      },
      closeCreate: () => {
        setCreating(false);
        setCreatePrefill(null);
        setCreateDefaults(null);
      },
    }),
    [view, openItemId, creating, createPrefill, createDefaults],
  );

  return h(NavCtx.Provider, { value: nav }, props.children);
}

export function useNav(): Nav {
  const nav = useContext(NavCtx);
  if (nav === null) throw new Error("useNav() outside <NavProvider>");
  return nav;
}

// ---------------------------------------------------------------------------
// Toast (single slim top notice, optional Undo — PLAN.md §2's undo toast)
// ---------------------------------------------------------------------------

export const TOAST_MS = 3000;
/** Slide in/out duration — keep in step with styles.css .toast animations. */
const TOAST_ANIM_MS = 150;

export type ShowToast = (message: string, undo?: () => void) => void;

interface ActiveToast {
  message: string;
  undo: (() => void) | undefined;
}

const ToastCtx = createContext<ShowToast | null>(null);

/**
 * Owns toast state AND renders the notice element (.toast in styles.css): a
 * compact tap-through pill docked top-right — the bottom toast parked
 * itself exactly on the controls the user just tapped, and a full-width
 * top strip covered the back link ("‹ Locations") for its 3 s, so the pill
 * stays off the screen's left edge. The container takes no pointer events
 * (only the Undo button does), so it can never block a control. A new
 * toast replaces the current one — a burst of writes shows only the
 * latest, and its undo compensates only that write.
 */
export function ToastProvider(props: { children: ComponentChildren }) {
  const [active, setActive] = useState<ActiveToast | null>(null);
  /** Sliding out: the element stays mounted with .toast-leaving for the
   *  exit animation, then unmounts. Any new toast cancels the exit. */
  const [leaving, setLeaving] = useState(false);

  const show = useRef<ShowToast>((message, undo) => {
    setLeaving(false);
    setActive({ message, undo });
  });

  // Each new toast object restarts the window (identity changes per show);
  // expiry starts the slide-out rather than unmounting outright.
  useEffect(() => {
    if (active === null) return;
    const t = setTimeout(() => setLeaving(true), TOAST_MS);
    return () => clearTimeout(t);
  }, [active]);

  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => {
      setActive(null);
      setLeaving(false);
    }, TOAST_ANIM_MS);
    return () => clearTimeout(t);
  }, [leaving]);

  const undoBtn =
    active !== null && active.undo !== undefined
      ? h(
          "button",
          {
            class: "toast-undo",
            type: "button",
            onClick: () => {
              // Instant dismissal (no exit slide): the state must visibly
              // snap back the moment undo runs, and an animating button
              // must not accept a second, double-undoing tap.
              const undo = active.undo;
              setActive(null);
              setLeaving(false);
              if (undo !== undefined) undo();
            },
          },
          "Undo",
        )
      : null;

  const toastNode =
    active === null
      ? null
      : h(
          "div",
          { class: `toast${leaving ? " toast-leaving" : ""}`, role: "status" },
          h("span", { class: "toast-msg" }, active.message),
          undoBtn,
        );

  return h(ToastCtx.Provider, { value: show.current }, props.children, toastNode);
}

/** Show a toast: `toast("Paprika: 2 bags", () => store.undoQuantity(...))`. */
export function useToast(): ShowToast {
  const show = useContext(ToastCtx);
  if (show === null) throw new Error("useToast() outside <ToastProvider>");
  return show;
}

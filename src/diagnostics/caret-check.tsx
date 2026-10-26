/** Temporary synthetic-only check. No app, store, storage or worker imports. */
import { render } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Sheet } from "../ui/ModalView";

declare const __CARET_IDENTITY__: Record<string, string>;
type Case = "A" | "B" | "C";
const cases: Case[] = ["A", "B", "C"];
let liveTrace: ReturnType<typeof recording> | null = null;
const labels = { A: "Plain field", B: "Ambry dialog", C: "Alternative dialog" };
const positioned = ["position", "top", "left", "width"] as const;
const styleSnapshot = () => Object.fromEntries(["overflow", ...positioned].map(key =>
  [key, { value: document.body.style.getPropertyValue(key), priority: document.body.style.getPropertyPriority(key) }]));
const round = (n: number) => Math.round(n * 100) / 100;
function geometry(nodeId: (node: Element) => number) {
  const input = document.getElementById("check-name") as HTMLInputElement | null;
  const rect = input?.getBoundingClientRect();
  const dialog = input?.closest(".sheet");
  const v = window.visualViewport;
  return {
    active: document.activeElement?.id || document.activeElement?.getAttribute("role") || document.activeElement?.tagName,
    node: input ? nodeId(input) : null,
    selection: input ? [input.selectionStart, input.selectionEnd, input.selectionDirection] : null,
    length: input?.value.length,
    // Classify only the expected synthetic results; never retain arbitrary text.
    result: input ? (["cookie", "cxookie", "caie"].includes(input.value) ? input.value : "other") : null,
    rect: rect ? [rect.x, rect.y, rect.width, rect.height].map(round) : null,
    window: [window.scrollX, window.scrollY, window.innerWidth, window.innerHeight],
    dialogScroll: dialog ? [dialog.scrollLeft, dialog.scrollTop] : null,
    viewport: v ? [v.offsetLeft, v.offsetTop, v.width, v.height, v.scale].map(round) : null,
  };
}
function recording(id: Case) {
  const start = performance.now();
  const before = { body: styleSnapshot(), scroll: [scrollX, scrollY] };
  const nodes = new WeakMap<Element, number>();
  let nextNode = 0;
  const nodeId = (node: Element) => {
    if (!nodes.has(node)) nodes.set(node, ++nextNode);
    return nodes.get(node)!;
  };
  // Noisy geometry observations cannot consume the input/focus budget. Each
  // bounded queue retains its most recent observations; final state is separate.
  const events: object[] = [];
  const observations: object[] = [];
  const dropped = { critical: 0, observations: 0, coalesced: 0 };
  let lastObservation = -Infinity;
  const note = (type: string, detail?: object) => {
    const now = performance.now() - start;
    const noisy = type === "selectionchange" || type === "viewport";
    if (noisy && now - lastObservation < 75) { dropped.coalesced++; return; }
    if (noisy) lastObservation = now;
    const queue = noisy ? observations : events;
    const limit = noisy ? 64 : 128;
    if (queue.length >= limit) { queue.shift(); dropped[noisy ? "observations" : "critical"]++; }
    queue.push({ ms: round(now), type, ...detail, ...geometry(nodeId) });
  };
  const observe = (event: Event) => {
    if (event.type !== "selectionchange" && event.target !== document.getElementById("check-name")) return;
    note(event.type, event instanceof InputEvent ? { inputType: event.inputType } : undefined);
  };
  const viewport = () => note("viewport");
  const types = ["selectionchange", "beforeinput", "input", "focusin", "focusout"];
  types.forEach(type => document.addEventListener(type, observe, true));
  window.visualViewport?.addEventListener("resize", viewport);
  window.visualViewport?.addEventListener("scroll", viewport);
  note("before-mount");
  return {
    id, before, note,
    finish() {
      note("after-unmount");
      types.forEach(type => document.removeEventListener(type, observe, true));
      window.visualViewport?.removeEventListener("resize", viewport);
      window.visualViewport?.removeEventListener("scroll", viewport);
      liveTrace = null;
      return { id, before, after: { body: styleSnapshot(), scroll: [scrollX, scrollY], ...geometry(nodeId) }, events, observations, dropped };
    },
  };
}
type Recording = ReturnType<typeof recording>;

function Sample({ trace, finish }: { trace: Recording; finish: () => void }) {
  const [name, setName] = useState("cookie");
  const nameRef = useRef<HTMLInputElement>(null);
  // Exact CreateSheet initial passive effect, with a synthetic cookie prefill.
  useEffect(() => {
    const el = nameRef.current;
    if (!el) return;
    trace.note("app-focus-once");
    el.focus();
    trace.note("app-selection-end-once");
    el.setSelectionRange(el.value.length, el.value.length);
    trace.note("after-name-focus");
  }, []);
  return <form class="create-form" onSubmit={e => { e.preventDefault(); finish(); }}>
    <input id="check-name" ref={nameRef} class="field-input" type="text" aria-label="Name" placeholder="Name" autocomplete="off" value={name} onInput={e => setName(e.currentTarget.value)} />
    <fieldset class="create-unit-package"><legend class="item-section-title">Unit &amp; package</legend>
      <div class="item-field">
        <label class="item-label" for="sample-unit">Unit</label>
        <select id="sample-unit" class="field-input" disabled><optgroup label="Common units"><option>Count (individual items)</option></optgroup></select>
        <button class="btn" type="button" disabled>Add new unit…</button>
      </div>
      <div class="item-field">
        <label class="item-label" for="sample-quantity">Quantity</label>
        <input id="sample-quantity" class="field-input item-num" type="text" inputMode="decimal" autocomplete="off" disabled value="1" />
      </div>
      <details class="create-package"><summary>Package size (optional)</summary><div class="create-package-fields">
        <p>1 item contains:</p>
        <label class="item-field"><span class="item-label">Package amount</span><input class="field-input item-num" disabled placeholder="e.g. 500" /></label>
        <label class="item-field"><span class="item-label">Package unit</span><input class="field-input" disabled placeholder="e.g. g or ml" /></label>
        <p class="muted item-hint">Example: 1 bag = 500 g. Quantity counts bags; package size describes one bag.</p>
      </div></details>
    </fieldset>
    <div class="item-field"><div class="item-label">Location</div><div class="chips">
      {["Pantry", "Fridge", "Freezer", "＋ New…"].map(label => <button class="chip" type="button" disabled>{label}</button>)}
    </div></div>
    <div class="item-field"><div class="item-label">Category</div><div class="chips"><button class="chip" type="button" disabled>＋ New…</button></div></div>
    <button class="btn" type="button" disabled>More options</button>
    <button class="btn btn-primary btn-big" type="submit">Finish case {trace.id}</button>
  </form>;
}
function Trial({ trace, finish }: { trace: Recording; finish: () => void }) {
  useLayoutEffect(() => {
    trace.note("after-modal-open", { body: styleSnapshot() });
    if (trace.id === "C") {
      // Sheet's child layout effect has already opened the EXACT current modal.
      // Omit ONLY its fixed-body declarations; retain overflow/inert/ARIA/focus.
      trace.note("variant-before", { body: styleSnapshot() });
      for (const key of positioned) {
        const prior = trace.before.body[key]!;
        if (prior.value) document.body.style.setProperty(key, prior.value, prior.priority);
        else document.body.style.removeProperty(key);
      }
      trace.note("variant-after", { body: styleSnapshot(), omitted: positioned });
    }
  }, []);
  const sample = <Sample trace={trace} finish={finish} />;
  return trace.id === "A"
    ? <section class="check-plain" aria-label="Case A"><h2>Case A · {labels.A}</h2>{sample}</section>
    : <Sheet open title={`Case ${trace.id} · ${labels[trace.id]}`} onClose={finish}>{sample}</Sheet>;
}

function Check() {
  const [active, setActive] = useState<Recording | null>(null);
  const [step, setStep] = useState(0);
  const [answering, setAnswering] = useState(false);
  const [copy, setCopy] = useState("");
  const [fallback, setFallback] = useState("");
  const results = useRef<object[]>([]);
  const pending = useRef<Recording | null>(null);
  const [launcher, setLauncher] = useState("cookie");
  const identity = useRef({
    artifact: __CARET_IDENTITY__,
    standalone: matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true,
    platform: navigator.userAgent,
    deviations: ["Synthetic cookie prefill from warm-keyboard launcher, not typing into an empty or cold-launched form", "Representative production form wrappers/classes; no duplicate guard; fixed synthetic location chips; other controls disabled; Finish replaces Add", "No live app data or app lifecycle initialization", "Keyboard visibility is not inferred from viewport size"],
    variants: { A: "Plain form", B: "Exact current Sheet/openModal", C: "B with only body position/top/left/width restored to pre-open values; overflow lock and isolation retained" },
  });
  useLayoutEffect(() => {
    if (active === null && pending.current) {
      results.current.push(pending.current.finish());
      pending.current = null;
      setAnswering(true);
    }
  }, [active]);
  const id = cases[step];
  const finish = () => { active?.note("before-unmount"); pending.current = active; setActive(null); };
  const answer = (observation: string) => {
    results.current.push({ id, observation });
    setAnswering(false);
    setStep(step + 1);
  };
  const report = () => JSON.stringify({ ...identity.current, cases: results.current, interpretation: "If B does not reproduce on the reported Home Screen iPhone, comparison is inconclusive. No phone fix established." }, null, 2);
  const copyResults = async () => {
    const text = report();
    try { await navigator.clipboard.writeText(text); setCopy("Results copied. Return to the conversation and paste them."); }
    catch { setFallback(text); setCopy("Could not copy automatically. Select and copy the results below."); }
  };
  return <>
    <main class="check-page">
      <h1>Text editing check</h1>
      <p>This uses a pretend name. It does not open or change your inventory. Nothing you type here is saved.</p>
      <p>In each case, try placing the cursor between <strong>c</strong> and <strong>o</strong> in cookie. If it works, type <strong>x</strong>, then delete it. Tap Finish case when done.</p>
      <p>There are three short cases. Copy the results once at the end.</p>
      {id && !answering && <section>
        <h2>Case {id} · {labels[id]}</h2>
        <p>Tap the name below to bring up the keyboard, then tap Open case {id}.</p>
        <input id="check-launcher" class="field-input" type="text" aria-label="Prepare keyboard" autocomplete="off" value={launcher} onInput={e => setLauncher(e.currentTarget.value)} />
        <button id="check-open" class="btn" type="button" disabled={active !== null} onClick={() => { setCopy(""); liveTrace = recording(id); setActive(liveTrace); }}>Open case {id}</button>
      </section>}
      {answering && <section aria-label={`Case ${id} result`}>
        <h2>What happened in case {id}?</h2>
        <button class="btn" onClick={() => answer("middle")}>Cursor reached the middle</button>
        <button class="btn" onClick={() => answer("ends-only")}>Only beginning or end</button>
        <button class="btn" onClick={() => answer("not-tested")}>Could not test</button>
      </section>}
      {!id && <button class="btn" onClick={copyResults}>Copy results</button>}
      <p role="status">{copy}</p>
      {fallback && <textarea aria-label="Results to copy" readOnly value={fallback} rows={10} />}
      <p><a href="/">Return to Ambry</a></p>
    </main>
    {active && <Trial key={active.id} trace={active} finish={finish} />}
  </>;
}
render(<Check />, document.getElementById("check-root")!);
// These listeners intentionally outlive the component, so Back/Forward can
// remount a fresh check after pagehide removed every draft and modal listener.
window.addEventListener("pagehide", () => {
  liveTrace?.finish();
  render(null, document.getElementById("check-root")!);
});
window.addEventListener("pageshow", event => {
  if (event.persisted) render(<Check />, document.getElementById("check-root")!);
});

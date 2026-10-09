import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon, type IconName } from "./icons";

/** Accent = neutral/info, ok = succeeded, warn = needs a decision, danger = failed or destroys something. */
export type Tone = "accent" | "ok" | "warn" | "danger";

/** The header every modal shares: tinted icon badge, title, optional one-line subtitle. */
export function ModalHead({ id, icon, tone = "accent", title, sub }: { id: string; icon: IconName; tone?: Tone; title: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <header className="modal-head">
      <span className={`modal-badge tone-${tone}`}><Icon name={icon} /></span>
      <div>
        <h2 id={id}>{title}</h2>
        {sub && <p className="muted">{sub}</p>}
      </div>
    </header>
  );
}

/** The app name, set larger in the brand gradient wherever it shows up in visible text. */
export const Brand = () => <span className="brand-name">git-ai</span>;

// In-app replacement for the native confirm box, so confirms look like every other modal.
/** One option of `choose`: `hint` is a plain line under the label; `suggested` tags the likely right pick. */
export type Choice = { label: string; hint?: string; tone?: Tone; suggested?: boolean };
/** A text field of `prompt`. */
export type Field = { label: string; value?: string; placeholder?: string };
type Ask = { title: string; message: string; icon: IconName; tone: Tone; choices: Choice[]; fields?: Field[]; resolve: (i: number, values: string[]) => void };
let asking: Ask | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

/** Resolves the index of the picked choice, -1 on Cancel or Esc. */
export function choose(title: string, message: string, choices: Choice[], icon: IconName = "warn", tone: Tone = "accent") {
  asking?.resolve(-1, []);
  return new Promise<number>((resolve) => { asking = { title, message, icon, tone, choices, resolve }; emit(); });
}

/** Asks for one or more lines of text; resolves the trimmed values, or null on Cancel or Esc. */
export function prompt(title: string, message: string, fields: Field[], ok: string, icon: IconName = "branch") {
  asking?.resolve(-1, []);
  return new Promise<string[] | null>((resolve) => {
    asking = { title, message, icon, tone: "accent", choices: [{ label: ok }], fields, resolve: (i, v) => resolve(i === 0 ? v : null) };
    emit();
  });
}

/** Resolves true on the OK button, false on Cancel or Esc. */
export const confirm = (title: string, message: string, ok = "OK", tone: Tone = "warn") =>
  choose(title, message, [{ label: ok, tone }], "warn", tone).then((i) => i === 0);

export function ConfirmDialog() {
  const cur = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => asking);
  const dialog = useRef<HTMLDialogElement>(null);
  // Keep the last text through the close transition.
  const last = useRef(cur);
  if (cur) last.current = cur;
  const [values, setValues] = useState<string[]>([]);
  useEffect(() => {
    setValues(cur?.fields?.map((f) => f.value ?? "") ?? []);
    if (cur) dialog.current?.showModal();
    else dialog.current?.close();
  }, [cur]);
  const answer = (i: number) => { asking?.resolve(i, values.map((v) => v.trim())); asking = null; emit(); };
  const a = last.current;
  const one = a?.choices.length === 1 ? a.choices[0] : null;
  return (
    <dialog ref={dialog} className={`modal tone-${a?.tone ?? "warn"}`} role="alertdialog" aria-labelledby="confirm-title" aria-describedby="confirm-text"
      onCancel={(e) => { e.preventDefault(); answer(-1); }}>
      {a && (
        <form onSubmit={(e) => { e.preventDefault(); answer(0); }}>
          <ModalHead id="confirm-title" icon={a.icon} tone={a.tone} title={a.title} />
          {a.message && <p id="confirm-text" className="modal-text">{a.message}</p>}
          {a.fields?.map((f, i) => (
            <label key={f.label} className="nb-field prompt-field">{f.label}
              <input autoFocus={i === 0} value={values[i] ?? ""} placeholder={f.placeholder} spellCheck={false} autoComplete="off"
                onChange={(e) => setValues((v) => v.map((x, k) => (k === i ? e.target.value : x)))} />
            </label>
          ))}
          {!one && (
            <div className="choices">
              {a.choices.map((c, i) => (
                <button key={c.label} type="button" className={`choice tone-${c.tone ?? "accent"}`} onClick={() => answer(i)}>
                  <strong>{c.label}{c.suggested && <span className="choice-tag">Suggested</span>}</strong>{c.hint && <span className="muted">{c.hint}</span>}
                </button>
              ))}
            </div>
          )}
          <div className="dialog-actions">
            {/* Focus on Cancel: every confirm guards something destructive, so a stray Enter is safe. */}
            <button type="button" autoFocus={!a.fields} onClick={() => answer(-1)}>Cancel</button>
            {one && <button className={one.tone === "danger" ? "danger" : "primary"} disabled={values.some((v) => !v.trim())}>{one.label}</button>}
          </div>
        </form>
      )}
    </dialog>
  );
}

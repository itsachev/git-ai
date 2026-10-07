import { useEffect, useRef, useSyncExternalStore } from "react";
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
type Ask = { title: string; message: string; ok: string; tone: Tone; resolve: (yes: boolean) => void };
let asking: Ask | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

/** Resolves true on the OK button, false on Cancel or Esc. */
export function confirm(title: string, message: string, ok = "OK", tone: Tone = "warn") {
  asking?.resolve(false);
  return new Promise<boolean>((resolve) => { asking = { title, message, ok, tone, resolve }; emit(); });
}

export function ConfirmDialog() {
  const cur = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => asking);
  const dialog = useRef<HTMLDialogElement>(null);
  // Keep the last text through the close transition.
  const last = useRef(cur);
  if (cur) last.current = cur;
  useEffect(() => {
    if (cur) dialog.current?.showModal();
    else dialog.current?.close();
  }, [cur]);
  const answer = (yes: boolean) => { asking?.resolve(yes); asking = null; emit(); };
  const a = last.current;
  return (
    <dialog ref={dialog} className={`modal tone-${a?.tone ?? "warn"}`} role="alertdialog" aria-labelledby="confirm-title" aria-describedby="confirm-text"
      onCancel={(e) => { e.preventDefault(); answer(false); }}>
      {a && (
        <form onSubmit={(e) => { e.preventDefault(); answer(true); }}>
          <ModalHead id="confirm-title" icon="warn" tone={a.tone} title={a.title} />
          <p id="confirm-text" className="modal-text">{a.message}</p>
          <div className="dialog-actions">
            {/* Focus on Cancel: every confirm guards something destructive, so a stray Enter is safe. */}
            <button type="button" autoFocus onClick={() => answer(false)}>Cancel</button>
            <button className={a.tone === "danger" ? "danger" : "primary"}>{a.ok}</button>
          </div>
        </form>
      )}
    </dialog>
  );
}

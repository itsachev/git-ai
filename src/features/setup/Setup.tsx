import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { setupDone, setupFinish, sshKey } from "../../lib/ipc";
import { Icon, type IconName } from "../../lib/icons";
import { Brand } from "../../lib/modal";
import { ThemeButton, type Theme } from "../../lib/theme";
import { AiKey, GitIdentity, SshKey, aiKeyQuery, gitSetupQuery, helperName } from "../settings/Settings";

// First-run setup: shown once on launch until finished or skipped; the palette can open it again.
let forced = false;
const subs = new Set<() => void>();
export const openSetup = () => { forced = true; subs.forEach((f) => f()); };

const STEPS: { label: string; icon: IconName; title: string; lede: React.ReactNode }[] = [
  { label: "Git", icon: "branch", title: "Who are you in the history?", lede: "Set the name and email on your commits, and let git remember your sign-ins." },
  { label: "SSH", icon: "remote", title: "Connect to your remotes", lede: <><Brand /> talks to GitHub and friends over SSH. Pick the key that opens them.</> },
  { label: "AI", icon: "sparkle", title: "Bring your own AI key", lede: "Optional. A Gemini key writes commit messages and explains commits for you." },
  { label: "Done", icon: "check", title: "You're ready to commit", lede: "Everything below lives in Settings, so you can change it any time." },
];

/** Splits the title into words that rise one after another; the full title stays readable as one string. */
function Title({ text }: { text: string }) {
  return (
    <h2 id="setup-title" className="setup-title">
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {text.split(" ").map((w, i) => <span key={i} className="word" style={{ "--i": i } as React.CSSProperties}>{w} </span>)}
      </span>
    </h2>
  );
}

/** The stepper drawn as a commit graph: one lane, a node per step, the lane fills as you go. */
function Lane({ step, go }: { step: number; go: (i: number) => void }) {
  return (
    <ol className="setup-lane" style={{ "--p": step / (STEPS.length - 1) } as React.CSSProperties}>
      {STEPS.map((s, i) => (
        <li key={s.label} className={i < step ? "done" : i === step ? "now" : undefined}>
          <button type="button" onClick={() => go(i)} disabled={i > step} aria-current={i === step ? "step" : undefined}>
            <span className="node">{i < step && <Icon name="check" />}</span>
            <span className="lbl"><small>{String(i + 1).padStart(2, "0")}</small>{s.label}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function Summary() {
  const git = useQuery(gitSetupQuery).data;
  const ssh = useQuery({ queryKey: ["ssh-key"], queryFn: sshKey }).data;
  const ai = useQuery(aiKeyQuery).data;
  const rows: [IconName, string, string | null | undefined, boolean][] = [
    ["branch", "Commits as", git?.name && `${git.name} <${git.email ?? ""}>`, !!git?.name],
    ["remote", "HTTPS sign-ins", git?.helper ? `Saved by ${helperName(git.helper)}` : "Asked each time", !!git?.helper],
    ["remote", "SSH key", ssh ?? "ssh-agent and ~/.ssh defaults", true],
    ["sparkle", "AI features", ai ? "Gemini key set" : "Off (add a key in Settings)", !!ai],
  ];
  return (
    <ul className="setup-summary">
      {rows.map(([icon, k, v, ok], i) => (
        <li key={k} className={ok ? "ok" : undefined} style={{ "--i": i } as React.CSSProperties}>
          <Icon name={icon} />
          <span><small>{k}</small><strong>{v || "Not set"}</strong></span>
        </li>
      ))}
    </ul>
  );
}

export function SetupWizard({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  const qc = useQueryClient();
  const isForced = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => forced);
  const done = useQuery({ queryKey: ["setup-done"], queryFn: setupDone, staleTime: Infinity }).data;
  const show = isForced || done === false;
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState<"fwd" | "back">("fwd");
  const ssh = useQuery({ queryKey: ["ssh-key"], queryFn: sshKey, enabled: show }).data;
  const ai = useQuery({ ...aiKeyQuery, enabled: show }).data;
  const dialog = useRef<HTMLDialogElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (show && !dialog.current?.open) { setStep(0); dialog.current?.showModal(); }
  }, [show]);
  // Move focus into the step so keyboard users land on its first field, not the stepper.
  useEffect(() => {
    if (show) panel.current?.querySelector<HTMLElement>("input, select, button.primary")?.focus();
  }, [step, show]);

  const go = (i: number) => { setDir(i < step ? "back" : "fwd"); setStep(i); };
  async function finish() {
    await setupFinish().catch(() => {});
    forced = false;
    qc.setQueryData(["setup-done"], true);
    subs.forEach((f) => f());
    dialog.current?.close();
  }

  const s = STEPS[step];
  const last = step === STEPS.length - 1;
  const skippable = (step === 1 && !ssh) || (step === 2 && !ai);
  return (
    <dialog ref={dialog} className="modal setup" aria-labelledby="setup-title" aria-describedby="setup-lede"
      onCancel={(e) => { e.preventDefault(); finish(); }}>
      <Lane step={step} go={go} />
      <div ref={panel} key={step} className={`setup-step ${dir}`}>
        <header className="setup-head">
          <span className="modal-badge"><Icon name={s.icon} /></span>
          <div>
            <Title text={s.title} />
            <p id="setup-lede" className="muted">{s.lede}</p>
          </div>
        </header>
        {step === 0 && <GitIdentity formId="setup-git" onSaved={() => go(1)} />}
        {step === 1 && <SshKey />}
        {step === 2 && <AiKey />}
        {step === 3 && <Summary />}
      </div>
      <footer className="dialog-actions setup-actions">
        {step === 0 ? (
          <button type="button" className="ghost" onClick={finish}>Skip setup</button>
        ) : !last && (
          <button type="button" className="ghost" onClick={() => go(step - 1)}><Icon name="back" /> Back</button>
        )}
        <ThemeButton theme={theme} onChange={setTheme} />
        {step === 0 && <button className="primary" type="submit" form="setup-git">Continue</button>}
        {(step === 1 || step === 2) && (
          <button className="primary" onClick={() => go(step + 1)}>{skippable ? "Skip for now" : "Continue"}</button>
        )}
        {last && <button className="primary" autoFocus onClick={finish}>Start using git-ai</button>}
      </footer>
    </dialog>
  );
}

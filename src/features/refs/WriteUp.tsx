import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { aiWriteRange } from "../../lib/ipc";
import type { AppError } from "../../bindings/AppError";
import type { Refs } from "../../bindings/Refs";
import { Icon } from "../../lib/icons";
import { ModalHead } from "../../lib/modal";
import { useRun } from "../status/Changes";
import { aiKeyQuery, openSettings } from "../settings/Settings";
import { refsQuery } from "./Sidebar";

// AI write-up of what `head` adds on top of `base`: a PR title + description, or a release changelog.
// Opened from branch and tag menus and the palette. "" = HEAD, base null = guess the default branch.
type Kind = "pr" | "changelog";
type State = { kind: Kind; base: string | null; head: string };
let state: State | null = null;
const subs = new Set<() => void>();
export const openWriteUp = (kind: Kind, base: string | null = null, head = "") => { state = { kind, base, head }; subs.forEach((f) => f()); };
const close = () => { state = null; subs.forEach((f) => f()); };

/** main/master/develop, local first, else the remote copy; skips `head`. */
function defaultBase(refs: Refs | undefined, head: string) {
  const names = [...(refs?.local ?? []), ...(refs?.remote ?? [])].map((r) => r.name);
  const cur = head || refs?.head;
  for (const n of ["main", "master", "develop", "origin/main", "origin/master", "origin/develop"])
    if (names.includes(n) && n !== cur) return n;
  return "";
}

export function WriteUpDialog({ path }: { path: string }) {
  const cur = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => state);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (cur && !d?.open) d?.showModal();
    if (!cur && d?.open) d.close();
  }, [cur]);
  useEffect(() => close, []);
  return (
    <dialog ref={dialog} className="modal new-branch-dialog write-up" aria-labelledby="wu-title" onCancel={(e) => { e.preventDefault(); close(); }}>
      {cur && <Form key={JSON.stringify(cur)} path={path} initial={cur} />}
    </dialog>
  );
}

function RefOptions({ refs }: { refs: Refs | undefined }) {
  return (
    <>
      {!!refs?.local.length && <optgroup label="Branches">{refs.local.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}</optgroup>}
      {!!refs?.remote.length && <optgroup label="Remote branches">{refs.remote.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}</optgroup>}
      {!!refs?.tags.length && <optgroup label="Tags">{refs.tags.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}</optgroup>}
    </>
  );
}

function Form({ path, initial }: { path: string; initial: State }) {
  const refs = useQuery(refsQuery(path)).data;
  const hasKey = useQuery(aiKeyQuery).data;
  const run = useRun();
  const [kind, setKind] = useState(initial.kind);
  const [head, setHead] = useState(initial.head);
  const [base, setBase] = useState(initial.base);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  // Refs may load after the dialog opens; guess the base once they're here.
  const baseShown = base ?? defaultBase(refs, head);
  const headLabel = refs?.head ? `Current branch (${refs.head})` : "Current commit (HEAD)";
  const ok = !!baseShown && !busy;

  async function generate() {
    if (!hasKey) return openSettings();
    setBusy(true);
    await run(async () => {
      try {
        setText(await aiWriteRange(path, baseShown, head || "HEAD", kind));
      } catch (e) {
        if ((e as AppError).code === "ai_key") openSettings();
        throw e;
      }
    });
    setBusy(false);
  }
  async function copy() {
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); if (ok) generate(); }}>
      <ModalHead id="wu-title" icon="sparkle" title={kind === "pr" ? "PR description" : "Changelog"}
        sub="Commit messages and the combined diff go to Gemini. Edit the result before you use it." />

      <div className="nb-chips" role="group" aria-label="Write">
        <button type="button" className="chip" aria-pressed={kind === "pr"} onClick={() => setKind("pr")}>PR description</button>
        <button type="button" className="chip" aria-pressed={kind === "changelog"} onClick={() => setKind("changelog")}>Changelog</button>
      </div>

      <div className="wu-range">
        <div className="nb-field">
          <label htmlFor="wu-head">{kind === "pr" ? "Branch" : "Up to"}</label>
          <div className="select">
            <select id="wu-head" value={head} onChange={(e) => setHead(e.target.value)}>
              <option value="">{headLabel}</option>
              <RefOptions refs={refs} />
            </select>
            <Icon name="chevron" />
          </div>
        </div>
        <div className="nb-field">
          <label htmlFor="wu-base">{kind === "pr" ? "Into" : "Since"}</label>
          <div className="select">
            <select id="wu-base" value={baseShown} onChange={(e) => setBase(e.target.value)}>
              {!baseShown && <option value="">Pick a branch or tag</option>}
              <RefOptions refs={refs} />
            </select>
            <Icon name="chevron" />
          </div>
        </div>
      </div>
      <p className="nb-hint">Uses the commits on {head || refs?.head || "HEAD"} that aren't on {baseShown || "…"}.</p>

      {text && (
        <div className="nb-field">
          <label htmlFor="wu-text">Result (AI)</label>
          <textarea id="wu-text" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
        </div>
      )}

      <div className="dialog-actions">
        <button type="button" onClick={close}>Close</button>
        {text && <button type="button" onClick={copy}>{copied ? "Copied" : "Copy"}</button>}
        <button className="primary" disabled={!ok} title={hasKey ? undefined : "Add a Gemini API key in Settings first"}>
          {busy ? "Writing…" : text ? "Write again" : "Write"}
        </button>
      </div>
    </form>
  );
}

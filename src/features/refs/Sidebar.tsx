import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { checkout, deleteBranch, deleteRemoteBranch, deleteTag, merge, pushTag, rebaseOnto, refs, stash, stashSave, undo } from "../../lib/ipc";
import type { AppError } from "../../bindings/AppError";
import type { RefItem } from "../../bindings/RefItem";
import { errorText, opLabel, opLogQuery, useRun } from "../status/Changes";
import { Icon } from "../../lib/icons";
import { openNewBranch } from "./NewBranch";
import { openWriteUp } from "./WriteUp";
import { confirm } from "../../lib/modal";

/** Checkout that offers to bring conflicting local changes along instead of just failing. */
export async function switchTo(path: string, name: string, track: boolean) {
  try {
    await checkout(path, name, track);
  } catch (e) {
    if ((e as AppError).code !== "dirty") throw e;
    if (await confirm("Bring your changes along?", `Some changed files also differ on ${name}. Stash them, switch, and put them back on ${name}? If they clash, they stay in Stashes and the conflicts show in File Status.`, "Switch and bring changes"))
      await checkout(path, name, track, true);
  }
}

export const refsQuery = (path: string) => ({ queryKey: ["refs", path], queryFn: () => refs(path) });

export type Action = [string, () => void];

/** Menu actions for a branch, remote branch or tag by short name (shared by the sidebar and the graph's ref labels). */
export function useRefActions(path: string) {
  const data = useQuery(refsQuery(path)).data;
  const run = useRun();
  return (name: string): Action[] => {
    if (!data) return [];
    const head = data.head;
    const branchOff: Action = ["New branch from here", () => openNewBranch(name)];
    // Merge/rebase need a current branch that isn't this one.
    const onto: Action[] = head && head !== name ? [
      [`Merge into ${head}`, () => run(() => merge(path, name, false))],
      [`Rebase ${head} onto ${name}`, () => run(() => rebaseOnto(path, name), `Rebased ${head} onto ${name}`)],
    ] : [];
    if (data.local.some((b) => b.name === name)) {
      const pr: Action = ["Create pull request…", () => openWriteUp("pr", null, name)];
      if (name === head) return [branchOff, pr];
      return [["Checkout", () => run(() => switchTo(path, name, false))], branchOff, pr, ...onto, ["Delete", async () => {
        if (!(await confirm("Delete branch", `Delete branch ${name}? Undo history (sidebar) can restore it.`, "Delete", "danger"))) return;
        run(async () => {
          try {
            await deleteBranch(path, name, false);
          } catch (e) {
            if ((e as AppError).code !== "not_merged") throw e;
            if (await confirm("Delete unmerged branch", `${errorText(e)} Delete it anyway?`, "Delete anyway", "danger")) await deleteBranch(path, name, true);
          }
        });
      }]];
    }
    if (data.remote.some((r) => r.name === name)) {
      // Checks out as the local branch of the same name, created (tracking) if missing.
      const short = name.slice(name.indexOf("/") + 1);
      const hasLocal = data.local.some((b) => b.name === short);
      return [["Checkout", () => run(() => (hasLocal ? switchTo(path, short, false) : switchTo(path, name, true)))], branchOff, ...onto, ["Delete", async () => {
        if (await confirm("Delete remote branch", `Delete branch ${name} on the remote? Undo history (sidebar) can push it back.`, "Delete", "danger"))
          run(() => deleteRemoteBranch(path, name), `Deleted ${name} on the remote`);
      }]];
    }
    return [branchOff, ["Changelog since this tag (AI)", () => openWriteUp("changelog", name)], ["Push", () => run(() => pushTag(path, name), `Pushed tag ${name}`)], ["Delete", async () => {
      if (await confirm("Delete tag", `Delete tag ${name}? Undo history (sidebar) can restore it.`, "Delete", "danger"))
        run(() => deleteTag(path, name));
    }]];
  };
}

/** Opens a `RefMenu` popover: at the pointer on right-click, else under the clicked element. */
export function showMenu(el: HTMLElement | null, e: React.MouseEvent<HTMLElement>) {
  e.preventDefault();
  if (!el) return;
  const r = e.type === "contextmenu" ? { left: e.clientX, bottom: e.clientY } : e.currentTarget.getBoundingClientRect();
  el.showPopover();
  el.style.left = `${Math.max(4, Math.min(r.left, innerWidth - el.offsetWidth - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(r.bottom, innerHeight - el.offsetHeight - 4))}px`;
  el.querySelector("button")?.focus();
}

// ponytail: in-page popover; the native Tauri menu showed but its item clicks never arrived (Windows).
export function RefMenu({ pop, label, actions }: { pop: React.RefObject<HTMLDivElement | null>; label: string; actions: Action[] }) {
  return (
    <div ref={pop} popover="auto" className="row-menu" role="menu" aria-label={label}>
      {actions.map(([a, fn]) => <button key={a} role="menuitem" onClick={(e) => { e.stopPropagation(); pop.current!.hidePopover(); fn(); }}>{a}</button>)}
    </div>
  );
}

/** Branches, remotes, tags and stashes (Sourcetree's left sidebar). Double-click a branch to check it out. */
export function Sidebar({ path }: { path: string }) {
  const { data, error } = useQuery(refsQuery(path));
  const log = useQuery(opLogQuery(path)).data;
  const run = useRun();
  const actions = useRefActions(path);
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState<"stash" | null>(null);
  // The form lives inside the section, so open the section too (Stashes starts collapsed).
  const toggle = (what: "stash") => (e: React.MouseEvent<HTMLElement>) => {
    e.preventDefault();
    e.currentTarget.closest("details")!.open = true;
    setCreating((c) => (c === what ? null : what));
  };

  if (error) return <div className="sidebar error" role="alert">{errorText(error)}</div>;
  if (!data) return <div className="sidebar" />;
  const f = filter.trim().toLowerCase();
  const match = (items: RefItem[]) => items.filter((r) => r.name.toLowerCase().includes(f));
  const local = match(data.local);
  // ponytail: remote name = text before the first "/"; a remote named "a/b" would be split wrong.
  const remotes = new Map<string, RefItem[]>();
  for (const r of match(data.remote)) {
    const name = r.name.split("/")[0];
    remotes.set(name, [...(remotes.get(name) ?? []), r]);
  }

  async function dropStash(i: number, s: RefItem) {
    if (await confirm("Drop stash", `Drop stash "${s.name}"? Undo history (sidebar) can restore it.`, "Drop", "danger"))
      run(() => stash(path, "Drop", i, s.oid));
  }

  return (
    <section className="sidebar" aria-label="Branches">
      <label className="search"><Icon name="search" /><input type="search" placeholder="Filter" aria-label="Filter branches, tags, stashes and undo history"
        value={filter} onChange={(e) => setFilter(e.target.value)} /></label>
      <details open>
        <summary>
          <Icon name="branch" />Branches <span className="count">{data.local.length}</span>
          <button className="icon-btn" onClick={(e) => { e.preventDefault(); openNewBranch(); }} aria-label="New branch" title="New branch"><Icon name="add" /></button>
        </summary>
        <ul className="refs">
          {local.map((b) => {
            const cur = b.name === data.head;
            return <Row key={b.name} item={b} cur={cur} onOpen={cur ? undefined : () => run(() => switchTo(path, b.name, false))} actions={actions(b.name)} />;
          })}
        </ul>
      </details>
      <details open>
        <summary><Icon name="remote" />Remotes <span className="count">{data.remote.length}</span></summary>
        {[...remotes].map(([remote, items]) => (
          <details key={remote} open className="nested">
            <summary>{remote}</summary>
            <ul className="refs">
              {items.map((r) => (
                <Row key={r.name} item={r} label={r.name.slice(remote.length + 1)} onOpen={actions(r.name)[0][1]} actions={actions(r.name)} />
              ))}
            </ul>
          </details>
        ))}
      </details>
      <details>
        <summary><Icon name="tag" />Tags <span className="count">{data.tags.length}</span></summary>
        <ul className="refs">
          {match(data.tags).map((t) => (
            <Row key={t.name} item={t} actions={actions(t.name)} />
          ))}
        </ul>
      </details>
      <details>
        <summary>
          <Icon name="stash" />Stashes <span className="count">{data.stashes.length}</span>
          <button className="icon-btn" onClick={toggle("stash")} aria-expanded={creating === "stash"} aria-label="Stash all changes" title="Stash all changes"><Icon name="add" /></button>
        </summary>
        {creating === "stash" && <NameForm label="Stash message (optional)" button="Stash" optional onCancel={() => setCreating(null)}
          onSubmit={async (msg) => { if (await run(() => stashSave(path, msg))) setCreating(null); }} />}
        <ul className="refs">
          {data.stashes.map((s, i) => s.name.toLowerCase().includes(f) && (
            <Row key={s.oid} item={s} label={`stash@{${i}}: ${s.name}`} actions={[
              ["Apply", () => run(() => stash(path, "Apply", i, s.oid))],
              ["Pop", () => run(() => stash(path, "Pop", i, s.oid))],
              ["Drop", () => dropStash(i, s)],
            ]} />
          ))}
        </ul>
      </details>
      {log && log.length > 0 && (
        <details>
          <summary><Icon name="undo" />Undo history <span className="count">{log.length}</span></summary>
          <ul className="refs ops">
            {log.filter((e) => opLabel(e).toLowerCase().includes(f)).map((e) => (
              <li key={e.id}>
                <span className="name">
                  <span>{opLabel(e)}</span>
                  <small>{new Date(Number(e.id)).toLocaleString()}</small>
                </span>
                <button className="small" onClick={() => run(() => undo(path, e.id))}>Undo</button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/** `onOpen` runs on double-click; `actions` are [label, handler] items of a popover menu (right-click or the ⋯ button). */
type RowProps = { item: RefItem; label?: string; cur?: boolean; onOpen?: () => void; actions?: Action[] };

function Row({ item, label = item.name, cur, onOpen, actions = [] }: RowProps) {
  const title = item.upstream ? `${item.name} (tracks ${item.upstream})` : item.name;
  const pop = useRef<HTMLDivElement>(null);
  const menu = (e: React.MouseEvent<HTMLElement>) => showMenu(pop.current, e);
  return (
    <li className={cur ? "cur" : undefined} onContextMenu={menu}>
      <span className="name" title={title} onDoubleClick={onOpen}>
        {cur && <span className="dot" aria-label="current branch" />}
        <span>{label}</span>
        {item.ahead > 0 && <small className="ab" title={`${item.ahead} to push`}>↑{item.ahead}</small>}
        {item.behind > 0 && <small className="ab" title={`${item.behind} to pull`}>↓{item.behind}</small>}
      </span>
      {actions.length > 0 && (
        <>
          <button className="icon-btn more" onClick={menu} aria-label={`Actions for ${item.name}`} title="Actions"><Icon name="more" /></button>
          <RefMenu pop={pop} label={item.name} actions={actions} />
        </>
      )}
    </li>
  );
}

type NameFormProps = {
  label: string;
  button: string;
  /** Checkbox label; its value is passed to `onSubmit`. */
  check?: string;
  /** Allow submitting an empty name. */
  optional?: boolean;
  onSubmit: (name: string, checked: boolean) => void;
  onCancel: () => void;
};

/** Small inline form: one text field, optional checkbox, Esc cancels. */
export function NameForm({ label, button, check, optional, onSubmit, onCancel }: NameFormProps) {
  const [name, setName] = useState("");
  const [on, setOn] = useState(true);
  const ok = optional || !!name.trim();
  return (
    <form className="new-branch" onSubmit={(e) => { e.preventDefault(); if (ok) onSubmit(name.trim(), on); }}
      onKeyDown={(e) => e.key === "Escape" && onCancel()}>
      <input autoFocus aria-label={label} placeholder={label} value={name} onChange={(e) => setName(e.target.value)} />
      {check && <label className="check"><input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />{check}</label>}
      <button className="small primary" disabled={!ok}>{button}</button>
    </form>
  );
}

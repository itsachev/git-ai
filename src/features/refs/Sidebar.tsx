import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ask } from "@tauri-apps/plugin-dialog";
import { checkout, createBranch, deleteBranch, deleteRemoteBranch, deleteTag, merge, pushTag, refs, stash, stashSave } from "../../lib/ipc";
import type { AppError } from "../../bindings/AppError";
import type { RefItem } from "../../bindings/RefItem";
import { errorText, useRun } from "../status/Changes";

export const refsQuery = (path: string) => ({ queryKey: ["refs", path], queryFn: () => refs(path) });

/** Branches, remotes, tags and stashes (Sourcetree's left sidebar). Double-click a branch to check it out. */
export function Sidebar({ path }: { path: string }) {
  const { data, error } = useQuery(refsQuery(path));
  const [run, opError] = useRun();
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState<"branch" | "stash" | null>(null);
  const toggle = (what: "branch" | "stash") => (e: React.MouseEvent) => { e.preventDefault(); setCreating((c) => (c === what ? null : what)); };

  if (error) return <aside className="sidebar error" role="alert">{errorText(error)}</aside>;
  if (!data) return <aside className="sidebar" />;
  const f = filter.trim().toLowerCase();
  const match = (items: RefItem[]) => items.filter((r) => r.name.toLowerCase().includes(f));
  const local = match(data.local);
  const localNames = new Set(data.local.map((b) => b.name));
  // ponytail: remote name = text before the first "/"; a remote named "a/b" would be split wrong.
  const remotes = new Map<string, RefItem[]>();
  for (const r of match(data.remote)) {
    const name = r.name.split("/")[0];
    remotes.set(name, [...(remotes.get(name) ?? []), r]);
  }

  // A remote branch checks out as the local branch of the same name, created (tracking) if missing.
  const checkoutRemote = (name: string) => {
    const short = name.slice(name.indexOf("/") + 1);
    return run(() => (localNames.has(short) ? checkout(path, short, false) : checkout(path, name, true)));
  };
  const mergeIn = (name: string) => run(() => merge(path, name, false));
  async function dropStash(i: number, s: RefItem) {
    if (await ask(`Drop stash "${s.name}"? Undo history (File Status) can restore it.`, { title: "Drop stash", kind: "warning" }))
      run(() => stash(path, "Drop", i, s.oid));
  }
  async function removeRemote(name: string) {
    if (await ask(`Delete branch ${name} on the remote? Undo history (File Status) can push it back.`, { title: "Delete remote branch", kind: "warning" }))
      run(() => deleteRemoteBranch(path, name));
  }
  async function remove(name: string) {
    if (!(await ask(`Delete branch ${name}? Undo history (File Status) can restore it.`, { title: "Delete branch", kind: "warning" }))) return;
    run(async () => {
      try {
        await deleteBranch(path, name, false);
      } catch (e) {
        if ((e as AppError).code !== "not_merged") throw e;
        if (await ask(`${errorText(e)} Delete it anyway?`, { title: "Delete branch", kind: "warning" })) await deleteBranch(path, name, true);
      }
    });
  }

  return (
    <aside className="sidebar" aria-label="Branches">
      <input type="search" className="filter" placeholder="Filter branches" aria-label="Filter branches"
        value={filter} onChange={(e) => setFilter(e.target.value)} />
      {opError && <p className="error" role="alert">{opError}</p>}
      <details open>
        <summary>
          Branches ({data.local.length})
          <button className="small" onClick={toggle("branch")} aria-expanded={creating === "branch"} title="New branch">+ New</button>
        </summary>
        {creating === "branch" && <NameForm label="Branch name" check="Check out" button="Create" onCancel={() => setCreating(null)}
          onSubmit={async (name, co) => { if (await run(() => createBranch(path, name, co))) setCreating(null); }} />}
        <ul className="refs">
          {local.map((b) => {
            const cur = b.name === data.head;
            return (
              <Row key={b.name} item={b} cur={cur} onOpen={cur ? undefined : () => run(() => checkout(path, b.name, false))}
                actions={cur ? [] : [["Checkout", () => run(() => checkout(path, b.name, false))], ["Merge", () => mergeIn(b.name)], ["Delete", () => remove(b.name)]]} />
            );
          })}
        </ul>
      </details>
      <details open>
        <summary>Remotes ({data.remote.length})</summary>
        {[...remotes].map(([remote, items]) => (
          <details key={remote} open className="nested">
            <summary>{remote}</summary>
            <ul className="refs">
              {items.map((r) => (
                <Row key={r.name} item={r} label={r.name.slice(remote.length + 1)} onOpen={() => checkoutRemote(r.name)}
                  actions={[["Checkout", () => checkoutRemote(r.name)], ["Merge", () => mergeIn(r.name)], ["Delete", () => removeRemote(r.name)]]} />
              ))}
            </ul>
          </details>
        ))}
      </details>
      <details>
        <summary>Tags ({data.tags.length})</summary>
        <ul className="refs">
          {match(data.tags).map((t) => (
            <Row key={t.name} item={t} actions={[["Push", () => run(() => pushTag(path, t.name))], ["Delete", async () => {
              if (await ask(`Delete tag ${t.name}? Undo history (File Status) can restore it.`, { title: "Delete tag", kind: "warning" }))
                run(() => deleteTag(path, t.name));
            }]]} />
          ))}
        </ul>
      </details>
      <details>
        <summary>
          Stashes ({data.stashes.length})
          <button className="small" onClick={toggle("stash")} aria-expanded={creating === "stash"} title="Stash all changes">+ Stash</button>
        </summary>
        {creating === "stash" && <NameForm label="Stash message (optional)" button="Stash" optional onCancel={() => setCreating(null)}
          onSubmit={async (msg) => { if (await run(() => stashSave(path, msg))) setCreating(null); }} />}
        <ul className="refs">
          {data.stashes.map((s, i) => (
            <Row key={s.oid} item={s} label={`stash@{${i}}: ${s.name}`} actions={[
              ["Apply", () => run(() => stash(path, "Apply", i, s.oid))],
              ["Pop", () => run(() => stash(path, "Pop", i, s.oid))],
              ["Drop", () => dropStash(i, s)],
            ]} />
          ))}
        </ul>
      </details>
    </aside>
  );
}

/** `onOpen` runs on double-click; `actions` are [label, handler] buttons shown on hover/focus. */
type RowProps = { item: RefItem; label?: string; cur?: boolean; onOpen?: () => void; actions?: [string, () => void][] };

function Row({ item, label = item.name, cur, onOpen, actions = [] }: RowProps) {
  const title = item.upstream ? `${item.name} (tracks ${item.upstream})` : item.name;
  return (
    <li className={cur ? "cur" : undefined}>
      <span className="name" title={title} onDoubleClick={onOpen}>
        {cur && <span aria-label="current branch">●</span>}
        <span>{label}</span>
        {item.ahead > 0 && <small className="ab" title={`${item.ahead} to push`}>↑{item.ahead}</small>}
        {item.behind > 0 && <small className="ab" title={`${item.behind} to pull`}>↓{item.behind}</small>}
      </span>
      {actions.length > 0 && (
        <span className="acts">
          {actions.map(([a, fn]) => <button key={a} className="small" onClick={fn} aria-label={`${a} ${item.name}`}>{a}</button>)}
        </span>
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

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ask } from "@tauri-apps/plugin-dialog";
import { checkout, createBranch, deleteBranch, refs } from "../../lib/ipc";
import type { AppError } from "../../bindings/AppError";
import type { RefItem } from "../../bindings/RefItem";
import { errorText, useRun } from "../status/Changes";

/** Branches, remotes, tags and stashes (Sourcetree's left sidebar). Double-click a branch to check it out. */
export function Sidebar({ path }: { path: string }) {
  const { data, error } = useQuery({ queryKey: ["refs", path], queryFn: () => refs(path) });
  const [run, opError] = useRun();
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);

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
          <button className="small" onClick={(e) => { e.preventDefault(); setCreating((c) => !c); }}
            aria-expanded={creating} title="New branch">+ New</button>
        </summary>
        {creating && <NewBranch onCancel={() => setCreating(false)}
          onCreate={async (name, co) => { if (await run(() => createBranch(path, name, co))) setCreating(false); }} />}
        <ul className="refs">
          {local.map((b) => {
            const cur = b.name === data.head;
            return (
              <Row key={b.name} item={b} cur={cur} onCheckout={cur ? undefined : () => run(() => checkout(path, b.name, false))}
                onDelete={cur ? undefined : () => remove(b.name)} />
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
                <Row key={r.name} item={r} label={r.name.slice(remote.length + 1)} onCheckout={() => checkoutRemote(r.name)} />
              ))}
            </ul>
          </details>
        ))}
      </details>
      <details>
        <summary>Tags ({data.tags.length})</summary>
        <ul className="refs">{match(data.tags).map((t) => <Row key={t.name} item={t} />)}</ul>
      </details>
      <details>
        <summary>Stashes ({data.stashes.length})</summary>
        <ul className="refs">{data.stashes.map((s, i) => <Row key={s.oid} item={s} label={`stash@{${i}}: ${s.name}`} />)}</ul>
      </details>
    </aside>
  );
}

type RowProps = { item: RefItem; label?: string; cur?: boolean; onCheckout?: () => void; onDelete?: () => void };

function Row({ item, label = item.name, cur, onCheckout, onDelete }: RowProps) {
  const title = item.upstream ? `${item.name} (tracks ${item.upstream})` : item.name;
  return (
    <li className={cur ? "cur" : undefined}>
      <span className="name" title={title} onDoubleClick={onCheckout}>
        {cur && <span aria-label="current branch">●</span>}
        <span>{label}</span>
        {item.ahead > 0 && <small className="ab" title={`${item.ahead} to push`}>↑{item.ahead}</small>}
        {item.behind > 0 && <small className="ab" title={`${item.behind} to pull`}>↓{item.behind}</small>}
      </span>
      {(onCheckout || onDelete) && (
        <span className="acts">
          {onCheckout && <button className="small" onClick={onCheckout} aria-label={`Check out ${item.name}`}>Checkout</button>}
          {onDelete && <button className="small" onClick={onDelete} aria-label={`Delete ${item.name}`}>Delete</button>}
        </span>
      )}
    </li>
  );
}

function NewBranch({ onCreate, onCancel }: { onCreate: (name: string, checkout: boolean) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [co, setCo] = useState(true);
  return (
    <form className="new-branch" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onCreate(name.trim(), co); }}
      onKeyDown={(e) => e.key === "Escape" && onCancel()}>
      <input autoFocus aria-label="New branch name" placeholder="Branch name" value={name} onChange={(e) => setName(e.target.value)} />
      <label className="check"><input type="checkbox" checked={co} onChange={(e) => setCo(e.target.checked)} />Check out</label>
      <button className="small primary" disabled={!name.trim()}>Create</button>
    </form>
  );
}

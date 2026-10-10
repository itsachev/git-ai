import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { checkout, deleteBranch, deleteRemoteBranch, deleteTag, merge, pushTag, rebaseOnto, refs, remoteRemove, remoteSet, remotes, renameBranch, resetTo, setUpstream, stash, stashSave, undo } from "../../lib/ipc";
import type { AppError } from "../../bindings/AppError";
import type { RefItem } from "../../bindings/RefItem";
import { errorText, opLabel, opLogQuery, useRun } from "../status/Changes";
import { Icon } from "../../lib/icons";
import { openNewBranch } from "./NewBranch";
import { openExplainStash, openWriteUp } from "./WriteUp";
import { choose, confirm, prompt } from "../../lib/modal";
import { CLEAN, MOTION, gsap, useGSAP } from "../../lib/motion";

/** Checkout that offers to bring conflicting local changes along, or stash them, instead of just failing. */
export async function switchTo(path: string, name: string, track: boolean) {
  try {
    await checkout(path, name, track);
  } catch (e) {
    if ((e as AppError).code !== "dirty") throw e;
    const pick = await choose("Bring your changes along?", `Some changed files also differ on ${name}. What should happen to them?`, [
      { label: "Switch and bring changes", hint: `Stashes them, switches, and puts them back on ${name}. If they clash, nothing is switched and your changes stay here.` },
      { label: "Stash and switch", hint: `Parks them in Stashes and switches to a clean ${name}. Apply or Pop the stash later to get them back.` },
    ]);
    if (pick === 0) await checkout(path, name, track, true);
    if (pick === 1) {
      await stashSave(path, `before switching to ${name}`);
      await checkout(path, name, track);
    }
  }
}

export const refsQuery = (path: string) => ({ queryKey: ["refs", path], queryFn: () => refs(path) });
const remotesQuery = (path: string) => ({ queryKey: ["remotes", path], queryFn: () => remotes(path) });

/** [label, handler, why it is disabled (absent = enabled)] */
export type Action = [string, () => void, string?];

/** Menu actions for a branch, remote branch or tag by short name (shared by the sidebar and the graph's ref labels). */
export function useRefActions(path: string) {
  const data = useQuery(refsQuery(path)).data;
  const run = useRun();
  /** `ontoOnly`: just the merge/rebase actions (for branch drag and drop). */
  return (name: string, ontoOnly = false): Action[] => {
    if (!data) return [];
    const head = data.head;
    const branchOff: Action = ["New branch from here", () => openNewBranch(name)];
    // Merge/rebase need a current branch that isn't this one, and do nothing when it already has all of this one.
    const done = [...data.local, ...data.remote, ...data.tags].find((r) => r.name === name)?.in_head ? `${head} already has everything in ${name}` : undefined;
    const onto: Action[] = head && head !== name ? [
      [`Merge ${name} into ${head}`, () => run(() => merge(path, name, false), `Merged ${name} into ${head}`), done],
      [`Rebase ${head} onto ${name}`, () => run(() => rebaseOnto(path, name), `Rebased ${head} onto ${name}`), done],
    ] : [];
    if (ontoOnly) return onto;
    /** Checkout of a remote branch: its local namesake, created (tracking) if missing; asks what to do when the remote has commits the local lacks. */
    const checkoutRemote = (name: string) => {
      const short = name.slice(name.indexOf("/") + 1);
      const local = data.local.find((b) => b.name === short);
      const remote = data.remote.find((r) => r.name === name)!;
      // Ahead/behind are only known against the upstream; another remote just has to point elsewhere.
      const tracks = local?.upstream === name;
      const newer = local && (tracks ? local.behind > 0 : local.oid !== remote.oid);
      return async () => {
        if (!local) return run(() => switchTo(path, name, true));
        if (!newer) return run(() => switchTo(path, short, false));
        const behind = tracks ? `${local.behind} commit${local.behind === 1 ? "" : "s"}` : "commits";
        const own = tracks ? local.ahead : 1; // unknown: assume it may have its own
        const sw = head !== short;
        const lose = tracks ? `its ${own} commit${own === 1 ? "" : "s"} not on ${name}` : `any commits not on ${name}`;
        const pick = await choose(`Checkout ${name}`, `${name} has ${behind} that your local ${short} doesn't. What should ${short} do?`, [
          { label: sw ? `Switch and ${own ? `merge ${name}` : "fast-forward"}` : own ? `Merge ${name}` : "Fast-forward", hint: own ? `Merges ${name} into ${short}; your commits stay.` : `Moves ${short} up to ${name}.` },
          { label: `Recreate ${short} from ${name}`, tone: own ? "danger" : "accent", hint: own ? `Resets ${short} to ${name}, dropping ${lose}. Undo history can reverse it.` : `Resets ${short} to ${name}.` },
          { label: head === short ? `Keep ${short} as is` : `Switch to ${short} as is`, hint: `Leaves ${short} where it is; Pull later.` },
          { label: "New branch from here…", hint: `Starts a new local branch at ${name}.` },
        ], "branch");
        if (pick === 3) return openNewBranch(name);
        if (pick < 0) return;
        run(async () => {
          if (head !== short) await switchTo(path, short, false);
          if (pick === 0) await merge(path, name, false);
          if (pick === 1) await resetTo(path, name, "Keep");
        }, pick < 2 ? `${pick ? "Recreated" : "Updated"} ${short} from ${name}` : undefined);
      };
    };
    if (data.local.some((b) => b.name === name)) {
      const pr: Action = ["Create pull request…", () => openWriteUp("pr", null, name)];
      const explain: Action = ["Explain branch (AI)", () => openWriteUp("explain", null, name)];
      // Its upstream has new commits: offer the same choices as checking out the remote branch.
      const up = data.local.find((b) => b.name === name)!;
      const sync: Action[] = up.upstream && up.behind > 0 ? [[`Checkout ${up.upstream}…`, checkoutRemote(up.upstream)]] : [];
      const rename: Action = ["Rename…", async () => {
        const v = await prompt(`Rename ${name}`, "", [{ label: "New name", value: name }], "Rename");
        if (v && v[0] !== name) run(() => renameBranch(path, name, v[0]), `Renamed ${name} to ${v[0]}`);
      }];
      // Same-named remote branches first: that's almost always the one.
      const short = (r: string) => r.slice(r.indexOf("/") + 1);
      const candidates = data.remote.map((r) => r.name).filter((r) => r !== up.upstream && !r.endsWith("/HEAD"))
        .sort((a, b) => Number(short(b) === name) - Number(short(a) === name));
      const track: Action = [up.upstream ? "Change tracked branch…" : "Track remote branch…", async () => {
        const opts = [...candidates.map((r) => ({ label: r, hint: `Pull and Push use ${r}.` })),
          ...(up.upstream ? [{ label: "Stop tracking", hint: `${name} keeps its commits; Push publishes it again.`, tone: "warn" as const }] : [])];
        const i = await choose(`What should ${name} track?`, up.upstream ? `It tracks ${up.upstream} now.` : `${name} doesn't track a remote branch yet.`, opts, "remote");
        if (i < 0) return;
        const to = i < candidates.length ? candidates[i] : null;
        run(() => setUpstream(path, name, to), to ? `${name} now tracks ${to}` : `${name} no longer tracks ${up.upstream}`);
      }, candidates.length || up.upstream ? undefined : "No remote branches yet. Fetch or push first."];
      if (name === head) return [...sync, branchOff, pr, explain, rename, track];
      return [["Checkout", () => run(() => switchTo(path, name, false))], ...sync, branchOff, pr, explain, ...onto, rename, track, ["Delete", async () => {
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
      return [["Checkout", checkoutRemote(name)], branchOff, ...onto, ["Delete", async () => {
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

/** Opens a `RefMenu` popover: at the pointer on right-click or drop, else under the clicked element. */
export function showMenu(el: HTMLElement | null, e: React.MouseEvent<HTMLElement>) {
  e.preventDefault();
  if (!el) return;
  const r = e.type === "contextmenu" || e.type === "drop" ?{ left: e.clientX, bottom: e.clientY } : e.currentTarget.getBoundingClientRect();
  el.showPopover();
  el.style.left = `${Math.max(4, Math.min(r.left, innerWidth - el.offsetWidth - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(r.bottom, innerHeight - el.offsetHeight - 4))}px`;
  el.querySelector("button")?.focus();
}

// ponytail: in-page popover; the native Tauri menu showed but its item clicks never arrived (Windows).
export function RefMenu({ pop, label, actions }: { pop: React.RefObject<HTMLDivElement | null>; label: string; actions: Action[] }) {
  return (
    <div ref={pop} popover="auto" className="row-menu" role="menu" aria-label={label}>
      {actions.map(([a, fn, off]) => <button key={a} role="menuitem" disabled={!!off} title={off} onClick={(e) => { e.stopPropagation(); pop.current!.hidePopover(); fn(); }}>{a}</button>)}
    </div>
  );
}

/** Branches, remotes, tags and stashes (Sourcetree's left sidebar). Double-click a branch to check it out. */
export function Sidebar({ path }: { path: string }) {
  const { data, error } = useQuery(refsQuery(path));
  const remoteList = useQuery(remotesQuery(path)).data;
  const log = useQuery(opLogQuery(path)).data;
  const run = useRun();
  const actions = useRefActions(path);
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState<"stash" | null>(null);
  // Branch drag and drop: one end must be the current branch; the drop menu offers merge/rebase with the other.
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropActions, setDropActions] = useState<Action[]>([]);
  const dropPop = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement>(null);
  // Refs load after the rail mounts: when they arrive, sections slide in from the left and the first rows cascade after.
  useGSAP(() => {
    if (!root.current) return;
    gsap.matchMedia().add(MOTION, () => {
      gsap.timeline({ defaults: { ease: "expo.out", duration: 0.7, clearProps: CLEAN } })
        .from(root.current!.children, { opacity: 0, x: -14, stagger: 0.05 }, 0.1)
        .from(gsap.utils.toArray<HTMLElement>(".refs > li", root.current).slice(0, 16), { opacity: 0, x: -10, stagger: 0.025 }, 0.2);
    });
  }, { scope: root, dependencies: [!!data], revertOnUpdate: true });
  const other = (to: string) => (!dragging || dragging === to ? null : to === data?.head ? dragging : dragging === data?.head ? to : null);
  const dnd = (name: string): DragProps => ({
    onDragStart: () => setDragging(name),
    onDragEnd: () => setDragging(null),
    canDrop: !!other(name),
    onDrop: (e) => {
      const o = other(name);
      setDragging(null);
      if (!o) return;
      flushSync(() => setDropActions(actions(o, true)));
      showMenu(dropPop.current, e);
    },
  });
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
  // Every configured remote gets a group, even before it has branches (just added, not fetched).
  const groups = new Map<string, RefItem[]>((remoteList ?? []).map((r) => [r.name, []]));
  for (const r of match(data.remote)) {
    const name = r.name.split("/")[0];
    groups.set(name, [...(groups.get(name) ?? []), r]);
  }
  async function addRemote() {
    const v = await prompt("Add remote", "Fetch from it right after to see its branches.",
      [{ label: "Name", value: groups.size ? "" : "origin", placeholder: "upstream" }, { label: "URL", placeholder: "https://github.com/owner/repo.git" }], "Add remote", "remote");
    if (v) run(() => remoteSet(path, v[0], v[1], false), `Added remote ${v[0]}`);
  }
  const remoteActions = (name: string): Action[] => {
    const url = remoteList?.find((r) => r.name === name)?.url ?? "";
    return [
      ["Edit URL…", async () => {
        const v = await prompt(`URL of ${name}`, "", [{ label: "URL", value: url }], "Save", "remote");
        if (v && v[0] !== url) run(() => remoteSet(path, name, v[0], true), `${name} now points at ${v[0]}`);
      }],
      ["Remove", async () => {
        if (await confirm("Remove remote", `Remove ${name} (${url})? Its remote branches disappear here and local branches stop tracking it. Nothing changes on the server; add it again with the same URL to get it back.`, "Remove", "danger"))
          run(() => remoteRemove(path, name), `Removed remote ${name}`);
      }],
    ];
  };

  async function dropStash(i: number, s: RefItem) {
    if (await confirm("Drop stash", `Drop stash "${s.name}"? Undo history (sidebar) can restore it.`, "Drop", "danger"))
      run(() => stash(path, "Drop", i, s.oid));
  }

  return (
    <section ref={root} className="sidebar" aria-label="Branches">
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
            return <Row key={b.name} item={b} cur={cur} onOpen={cur ? undefined : () => run(() => switchTo(path, b.name, false))} actions={actions(b.name)} dnd={dnd(b.name)} />;
          })}
        </ul>
      </details>
      <details open>
        <summary>
          <Icon name="remote" />Remotes <span className="count">{data.remote.length}</span>
          <button className="icon-btn" onClick={(e) => { e.preventDefault(); e.currentTarget.closest("details")!.open = true; addRemote(); }} aria-label="Add remote" title="Add remote"><Icon name="add" /></button>
        </summary>
        {[...groups].map(([remote, items]) => (
          <details key={remote} open className="nested">
            <RemoteSummary name={remote} actions={remoteActions(remote)} />
            <ul className="refs">
              {items.map((r) => (
                <Row key={r.name} item={r} label={r.name.slice(remote.length + 1)} onOpen={actions(r.name)[0][1]} actions={actions(r.name)} dnd={dnd(r.name)} />
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
              ["Explain (AI)", () => openExplainStash(s.oid, `stash@{${i}}: ${s.name}`)],
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
      <RefMenu pop={dropPop} label="Drop branch" actions={dropActions} />
    </section>
  );
}

/** A remote's group header with its ⋯ menu (Edit URL, Remove). */
function RemoteSummary({ name, actions }: { name: string; actions: Action[] }) {
  const pop = useRef<HTMLDivElement>(null);
  return (
    <>
      <summary onContextMenu={(e) => showMenu(pop.current, e)}>
        <Icon name="chevron" />{name}
        <button className="icon-btn" onClick={(e) => showMenu(pop.current, e)} aria-label={`Actions for remote ${name}`} title="Actions"><Icon name="more" /></button>
      </summary>
      <RefMenu pop={pop} label={`Remote ${name}`} actions={actions} />
    </>
  );
}

/** `onOpen` runs on double-click; `actions` are [label, handler] items of a popover menu (right-click or the ⋯ button). */
type DragProps = { onDragStart: () => void; onDragEnd: () => void; canDrop: boolean; onDrop: (e: React.DragEvent<HTMLElement>) => void };
type RowProps = { item: RefItem; label?: string; cur?: boolean; onOpen?: () => void; actions?: Action[]; dnd?: DragProps };

function Row({ item, label = item.name, cur, onOpen, actions = [], dnd }: RowProps) {
  const title = item.upstream ? `${item.name} (tracks ${item.upstream})` : item.name;
  const pop = useRef<HTMLDivElement>(null);
  const menu = (e: React.MouseEvent<HTMLElement>) => showMenu(pop.current, e);
  const [over, setOver] = useState(false);
  return (
    <li className={[cur && "cur", over && "drop"].filter(Boolean).join(" ") || undefined} onContextMenu={menu}
      draggable={!!dnd}
      onDragStart={dnd && ((e) => { e.dataTransfer.setData("text/plain", item.name); e.dataTransfer.effectAllowed = "link"; dnd.onDragStart(); })}
      onDragEnd={dnd?.onDragEnd}
      onDragOver={dnd?.canDrop ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "link"; setOver(true); } : undefined}
      onDragLeave={() => setOver(false)}
      onDrop={dnd?.canDrop ? (e) => { setOver(false); dnd.onDrop(e); } : undefined}>
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

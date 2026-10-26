import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { checkout, mergedRefs, deleteBranch, deleteRemoteBranch, deleteTag, merge, pushTag, rebaseOnto, refs, remoteRemove, remoteSet, remotes, renameBranch, resetTo, setUpstream, stash, stashBranch, stashRename, stashSave, submoduleUpdate, submodules, undo, forgetOp } from "../../lib/ipc";
import type { AppError } from "../../bindings/AppError";
import type { RefItem } from "../../bindings/RefItem";
import { canUndo, confirmUndo, errorText, opLabel, opLogQuery, statusQuery, useRun } from "../status/Changes";
import { Icon } from "../../lib/icons";
import { openNewBranch } from "./NewBranch";
import { openExplainStash, openWriteUp } from "./WriteUp";
import { openStash, openStashSave } from "./Stash";
import { openCompare } from "../graph/Compare";
import { openReflog } from "./Reflog";

/** Opens `dir` (a repo) in a new tab; App listens. */
export const openRepoTab = (dir: string) => dispatchEvent(new CustomEvent("gitai-open-repo", { detail: dir }));
import { Local, Remote, choose, confirm, confirmCheck, prompt } from "../../lib/modal";
import { CLEAN, MOTION, gsap, useGSAP } from "../../lib/motion";

/** Switch that, when there are uncommitted changes, offers to bring them along, or stash them, instead of just failing. */
export async function switchTo(path: string, name: string, track: boolean) {
  try {
    await checkout(path, name, track);
  } catch (e) {
    if ((e as AppError).code !== "dirty") throw e;
    const to = track ? <Remote name={name} /> : <Local name={name} />;
    const sw = `git switch ${track ? "--track " : ""}${name}`;
    const pick = await choose("Bring your changes along?", <>You have uncommitted changes, so nothing was switched. Bring them to {to}, or stash them first?</>, [
      { label: "Switch and bring changes", hint: <>Stashes them, switches, and puts them back on {to}. If they clash, nothing is switched and your changes stay here.</>, git: `git stash push -u && ${sw} && git stash pop` },
      { label: "Stash and switch", hint: <>Parks them in Stashes and switches to a clean {to}. Apply or Pop the stash later to get them back.</>, git: `git stash push -u -m "before switching to ${name}" && ${sw}` },
    ]);
    if (pick === 0) await checkout(path, name, track, true);
    if (pick === 1) {
      await stashSave(path, `before switching to ${name}`);
      await checkout(path, name, track);
    }
  }
}

export const refsQuery = (path: string) => ({ queryKey: ["refs", path], queryFn: () => refs(path) });
export const remotesQuery = (path: string) => ({ queryKey: ["remotes", path], queryFn: () => remotes(path) });

/** `rev`: what git gets, for the dialog's command line. */
export const confirmMerge = (from: React.ReactNode, into: React.ReactNode, rev: string) =>
  confirm("Merge", <>Merge {from} into {into}? Undo history (sidebar) can reverse it.</>, "Merge", "warn", `git merge --no-edit ${rev}`);
export const confirmRebase = (branch: React.ReactNode, onto: React.ReactNode, rev: string) =>
  confirm("Rebase", <>Rebase {branch} onto {onto}? Its commits are rewritten on top of {onto}; if it was pushed, the next push needs Force push. Undo history (sidebar) can reverse it.</>, "Rebase", "warn", `git rebase --autostash ${rev}`);
/** "origin/feat" -> the command that deletes it on the remote. */
const pushDelete = (r: string) => `git push ${r.slice(0, r.indexOf("/"))} --delete ${r.slice(r.indexOf("/") + 1)}`;

/** Deletes local branch `name`, asking before force-deleting an unmerged one. False when the user backs out. */
async function deleteLocal(path: string, name: string) {
  try {
    await deleteBranch(path, name, false);
  } catch (e) {
    if ((e as AppError).code !== "not_merged") throw e;
    if (!(await confirm("Delete unmerged branch", `${errorText(e)} Delete it anyway?`, "Delete anyway", "danger", `git branch -D ${name}`))) return false;
    await deleteBranch(path, name, true);
  }
  return true;
}

/** [label, handler, why it is disabled (absent = enabled)] */
export type Action = [string, () => void, string?];

/** Why history-changing actions are off: a merge/rebase/cherry-pick/revert paused at conflicts. "" when none. */
export function usePaused(path: string) {
  const op = useQuery(statusQuery(path)).data?.operation;
  return op ? `Finish or abort the ${op} first` : "";
}
/** Actions that move HEAD, switch branches or touch the working tree: they can't run while an op is paused. */
export const PAUSE_BLOCKED = /^(Switch|Merge|Rebase|New branch|Reset|Apply|Pop|Stash|Pull|Push|Cherry-pick|Revert|Undo|Redo)\b/;
export const blockPaused = (actions: Action[], why: string): Action[] =>
  why ? actions.map(([a, fn, off]) => [a, fn, PAUSE_BLOCKED.test(a) ? why : off]) : actions;
/** Menu actions for a branch, remote branch or tag by short name (shared by the sidebar and the graph's ref labels). */
export function useRefActions(path: string) {
  const data = useQuery(refsQuery(path)).data;
  const merged = useQuery({ queryKey: ["merged", path], queryFn: () => mergedRefs(path) }).data;
  const run = useRun();
  const paused = usePaused(path);
  const remoteList = useQuery(remotesQuery(path)).data;
  /** Pushes tag `name` like Push does a branch: asks for a remote when there is none, and offers to
   *  replace the remote's tag when it points elsewhere (git refuses a plain push then). */
  async function pushTagTo(name: string) {
    let to = remoteList?.find((r) => r.name === "origin")?.name ?? remoteList?.[0]?.name;
    if (!to) {
      const v = await prompt("Push to a new remote", <>Tag <b>{name}</b> has nowhere to go yet. Paste the URL of the repository to push to.</>,
        [{ label: "Name", value: "origin", placeholder: "origin" }, { label: "URL", placeholder: "https://github.com/owner/repo.git" }], "Add and push", "remote",
        (v) => `git remote add ${v[0] || "<name>"} ${v[1] || "<url>"} && git push ${v[0] || "<name>"} refs/tags/${name}`);
      if (!v || !(await run(() => remoteSet(path, v[0], v[1], false), `Added remote ${v[0]}`))) return;
      to = v[0];
    }
    let taken = false;
    await run(async () => {
      try {
        await pushTag(path, name);
      } catch (e) {
        if ((e as AppError).code !== "tag_exists") throw e;
        taken = true;
      }
    }, () => (taken ? undefined : `Pushed tag ${name}`), `Pushing tag ${name} to ${to}…`);
    if (taken && await confirm(<>Replace tag <b>{name}</b> on {to}?</>,
      `${to} already has a tag ${name} on a different commit. Force push moves it to yours; anyone who fetched the old one keeps it until they fetch tags with --force. Undo history can't put the old tag back.`,
      "Force push", "danger", `git push --force ${to} refs/tags/${name}`))
      run(() => pushTag(path, name, true), `Force pushed tag ${name}`, `Force pushing tag ${name} to ${to}…`);
  }
  /** `ontoOnly`: just the merge/rebase actions (for branch drag and drop). */
  return (name: string, ontoOnly = false) => blockPaused(all(name, ontoOnly), paused);
  function all(name: string, ontoOnly: boolean): Action[] {
    if (!data) return [];
    const head = data.head;
    /** A ref name styled by kind: remote branch, local branch, or plain bold (tag). */
    const ref = (n: string) => data.remote.some((r) => r.name === n) ? <Remote name={n} />
      : data.local.some((b) => b.name === n) ? <Local name={n} /> : <b>{n}</b>;
    const branchOff: Action = ["New branch from here", () => openNewBranch(name)];
    // Merge/rebase need a current branch that isn't this one, and do nothing when it already has all of this one.
    const done = merged?.includes(name) ? `${head} already has everything in ${name}` : undefined;
    const onto: Action[] = head && head !== name ? [
      [`Merge ${name} into ${head}`, async () => (await confirmMerge(ref(name), <Local name={head} />, name)) && run(() => merge(path, name, false), <>Merged {ref(name)} into <Local name={head} /></>), done],
      [`Rebase ${head} onto ${name}`, async () => (await confirmRebase(<Local name={head} />, ref(name), name)) && run(() => rebaseOnto(path, name), <>Rebased <Local name={head} /> onto {ref(name)}</>), done],
    ] : [];
    if (ontoOnly) return onto;
    // A branch: what it has that the current one doesn't. A tag: what the current branch added since it.
    const isTag = data.tags.some((t) => t.name === name) && !data.local.some((b) => b.name === name);
    // One item; the dialog's From/To pick the other side. It starts at the current branch, or for the current branch
    // itself at its upstream (what's unpushed or not pulled yet). Compare puts the older side left.
    const upstream = data.local.find((b) => b.name === name)?.upstream;
    const other = head && head !== name ? head : upstream ?? data.local.find((b) => b.name !== name)?.name;
    const compare: Action[] = other
      ? [[isTag ? "Compare with a branch" : "Compare with another branch", () => (isTag ? openCompare(name, other) : openCompare(other, name, other !== upstream))]] : [];
    /** Checkout of a remote branch: its local namesake, created (tracking) if missing; asks what to do when the remote has commits the local lacks. */
    const checkoutRemote = (name: string) => {
      const short = name.slice(name.indexOf("/") + 1);
      const local = data.local.find((b) => b.name === short);
      const remote = data.remote.find((r) => r.name === name)!;
      // Ahead/behind are only known against the upstream; another remote just has to point elsewhere.
      const tracks = local?.upstream === name;
      const newer = local && (tracks ? local.behind > 0 : local.oid !== remote.oid);
      return async () => {
        if (!local) {
          const msg = <>Create local branch <Local name={short} /> tracking <Remote name={name} /> and switch to it?</>;
          if ((await choose(<>Switch / Checkout <Remote name={name} /></>, msg, [{ label: "Switch / Checkout", tone: "accent", git: `git switch --track ${name}` }], "branch")) !== 0) return;
          return run(() => switchTo(path, name, true), <>Created <Local name={short} /> from <Remote name={name} /> and switched to it</>);
        }
        if (!newer) return run(() => switchTo(path, short, false));
        const behind = tracks ? `${local.behind} commit${local.behind === 1 ? "" : "s"}` : "commits";
        const own = tracks ? local.ahead : 1; // unknown: assume it may have its own
        const sw = head !== short;
        const loc = <Local name={short} />, rem = <Remote name={name} />;
        const lose = tracks ? <>its {own} commit{own === 1 ? "" : "s"} not on {rem}</> : <>any commits not on {rem}</>;
        const msg = <>{rem} has {behind} that your local {loc} doesn't. What should {loc} do?</>;
        const then = sw ? `git switch ${short} && ` : "";
        const pick = await choose(<>Switch / Checkout {rem}</>, msg, [
          { label: sw ? <>Switch and {own ? <>merge {rem}</> : "fast-forward"}</> : own ? <>Merge {rem}</> : "Fast-forward", hint: own ? <>Merges {rem} into {loc}; your commits stay.</> : <>Moves {loc} up to {rem}.</>, git: `${then}git merge --no-edit ${name}` },
          { label: <>Recreate {loc} from {rem}</>, tone: own ? "danger" : "accent", hint: own ? <>Resets {loc} to {rem}, dropping {lose}. Undo history can reverse it.</> : <>Resets {loc} to {rem}.</>, git: `${then}git reset --keep ${name}` },
          { label: head === short ? <>Keep {loc} as is</> : <>Switch to {loc} as is</>, hint: <>Leaves {loc} where it is; Pull later.</>, git: sw ? `git switch ${short}` : undefined },
          { label: "New branch from here…", hint: <>Starts a new local branch at {rem}.</> },
        ], "branch");
        if (pick === 3) return openNewBranch(name);
        if (pick < 0) return;
        if (pick === 1 && own && !(await confirm(<>Recreate {loc}?</>, <>{loc} is reset to {rem}, dropping {lose}. Undo history (sidebar) can reverse it.</>, "Recreate", "danger", `${then}git reset --keep ${name}`))) return;
        run(async () => {
          if (head !== short) await switchTo(path, short, false);
          if (pick === 0) await merge(path, name, false);
          if (pick === 1) await resetTo(path, name, "Keep");
        }, pick < 2 ? <>{pick ? "Recreated" : "Updated"} {loc} from {rem}</> : undefined);
      };
    };
    if (data.local.some((b) => b.name === name)) {
      const pr: Action = ["Create pull/merge request", () => openWriteUp("pr", null, name)];
      const explain: Action = ["Explain branch (AI)", () => openWriteUp("explain", null, name)];
      // Its upstream has new commits: offer the same choices as checking out the remote branch.
      const up = data.local.find((b) => b.name === name)!;
      const sync: Action[] = up.upstream && up.behind > 0 ? [[`Switch / Checkout ${up.upstream}`, checkoutRemote(up.upstream)]] : [];
      const rename: Action = ["Rename", async () => {
        const v = await prompt(<>Rename <Local name={name} /></>, "", [{ label: "New name", value: name }], "Rename", "branch", (v) => `git branch -m ${name} ${v[0] || "<new-name>"}`);
        if (v && v[0] !== name) run(() => renameBranch(path, name, v[0]), <>Renamed <Local name={name} /> to <Local name={v[0]} /></>);
      }];
      // Same-named remote branches first: that's almost always the one.
      const short = (r: string) => r.slice(r.indexOf("/") + 1);
      const candidates = data.remote.map((r) => r.name).filter((r) => r !== up.upstream && !r.endsWith("/HEAD"))
        .sort((a, b) => Number(short(b) === name) - Number(short(a) === name));
      const track: Action = [up.upstream ? "Change tracked branch" : "Track remote branch", async () => {
        const me = <Local name={name} />;
        const opts = [...candidates.map((r) => ({ label: <Remote name={r} />, hint: <>Pull and Push use <Remote name={r} />.</>, git: `git branch --set-upstream-to=${r} ${name}` })),
          ...(up.upstream ? [{ label: "Stop tracking", hint: <>{me} keeps its commits; Push publishes it again.</>, tone: "warn" as const, git: `git branch --unset-upstream ${name}` }] : [])];
        const i = await choose(<>What should {me} track?</>, up.upstream ? <>It tracks <Remote name={up.upstream} /> now.</> : <>{me} doesn't track a remote branch yet.</>, opts, "remote");
        if (i < 0) return;
        const to = i < candidates.length ? candidates[i] : null;
        run(() => setUpstream(path, name, to), to ? <>{me} now tracks <Remote name={to} /></> : <>{me} no longer tracks <Remote name={up.upstream!} /></>);
      }, candidates.length || up.upstream ? undefined : "No remote branches yet. Fetch or push first."];
      if (name === head) return [["Switch / Checkout", () => {}, `Already on ${name}`], ...sync, branchOff, ...compare, pr, explain, rename, track];
      // The remote copy to offer deleting too: its upstream, else a same-named remote branch.
      const remote = up.upstream ?? data.remote.find((r) => short(r.name) === name)?.name;
      // Switch / Checkout (and double-click) just switches; being behind is Pull's job. The sync item offers the choices.
      return [["Switch / Checkout", () => run(() => switchTo(path, name, false))], ...sync, branchOff, ...compare, pr, explain, ...onto, rename, track, ["Delete", async () => {
        const msg = <>Delete branch <Local name={name} />? Undo history (sidebar) can restore it.</>;
        const alsoRemote = remote ? await confirmCheck("Delete branch", msg, "Delete", <span>Also delete <Remote name={remote} /> on the remote</span>, "danger", (_, c) => `git branch -d ${name}${c ? ` && ${pushDelete(remote)}` : ""}`)
          : (await confirm("Delete branch", msg, "Delete", "danger", `git branch -d ${name}`)) ? false : null;
        if (alsoRemote === null) return;
        let deleted = false;
        run(async () => {
          if (!(await deleteLocal(path, name))) return;
          if (alsoRemote) await deleteRemoteBranch(path, remote!);
          deleted = true;
        }, () => (alsoRemote && deleted ? <>Deleted <Local name={name} /> and <Remote name={remote!} /> on the remote</> : undefined));
      }]];
    }
    if (data.remote.some((r) => r.name === name)) {
      // The local copy to offer deleting too: the branch tracking it, else a same-named one. Never the current branch (git refuses).
      const short = name.slice(name.indexOf("/") + 1);
      const local = (data.local.find((b) => b.upstream === name) ?? data.local.find((b) => b.name === short))?.name;
      const offerLocal = local && local !== head ? local : undefined;
      return [["Switch / Checkout", checkoutRemote(name)], branchOff, ...compare, ...onto, ["Delete", async () => {
        const msg = <>Delete branch <Remote name={name} /> on the remote? Undo history (sidebar) can push it back.</>;
        const alsoLocal = offerLocal ? await confirmCheck("Delete remote branch", msg, "Delete", <span>Also delete local branch <Local name={offerLocal} /></span>, "danger", (_, c) => `${pushDelete(name)}${c ? ` && git branch -d ${offerLocal}` : ""}`)
          : (await confirm("Delete remote branch", msg, "Delete", "danger", pushDelete(name))) ? false : null;
        if (alsoLocal === null) return;
        let both = false;
        run(async () => {
          await deleteRemoteBranch(path, name);
          both = !!alsoLocal && (await deleteLocal(path, offerLocal!));
        }, () => (both ? <>Deleted <Remote name={name} /> on the remote and <Local name={offerLocal!} /></> : <>Deleted <Remote name={name} /> on the remote</>));
      }]];
    }
    return [branchOff, ...compare, ["Changelog since this tag (AI)", () => openWriteUp("changelog", name)], ["Push", () => pushTagTo(name)], ["Delete", async () => {
      if (await confirm("Delete tag", `Delete tag ${name}? Undo history (sidebar) can restore it.`, "Delete", "danger", `git tag -d ${name}`))
        run(() => deleteTag(path, name));
    }]];
  }
}

/** Opens a `RefMenu` popover: at the pointer on right-click or drop, else under the clicked element. */
export function showMenu(el: HTMLElement | null, e: React.MouseEvent<HTMLElement>) {
  e.preventDefault();
  if (!el) return;
  const at = e.type === "contextmenu" || e.type === "drop";
  const r = at ? { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY } : e.currentTarget.getBoundingClientRect();
  el.showPopover();
  const w = el.offsetWidth, h = el.offsetHeight;
  // No room below or right of the pointer: open upward / leftward from it instead of covering it.
  const up = r.bottom + h > innerHeight - 4 && r.top - h >= 4, left = at && r.left + w > innerWidth - 4;
  el.style.setProperty("--origin", `${up ? "bottom" : "top"} ${left ? "right" : "left"}`);
  el.style.left = `${Math.max(4, Math.min(left ? r.left - w : r.left, innerWidth - w - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(up ? r.top - h : r.bottom, innerHeight - h - 4))}px`;
  el.querySelector("button")?.focus();
}

// ponytail: in-page popover; the native Tauri menu showed but its item clicks never arrived (Windows).
export function RefMenu({ pop, label, actions }: { pop: React.RefObject<HTMLDivElement | null>; label: string; actions: Action[] }) {
  // Destructive actions sink to the bottom as their own red group.
  const risky = (a: string) => DESTRUCTIVE.test(a);
  const sorted = [...actions.filter(([a]) => !risky(a)), ...actions.filter(([a]) => risky(a))];
  return (
    <div ref={pop} popover="auto" className="row-menu" role="menu" aria-label={label} onKeyDown={menuKeys}>
      {sorted.map(([a, fn, off], i) => (
        <button key={a} role="menuitem" className={risky(a) ? "risky" : undefined} style={{ "--i": i } as React.CSSProperties} disabled={!!off} title={!off && a.length > 30 ? a : undefined}
          onClick={(e) => { e.stopPropagation(); pop.current!.hidePopover(); fn(); }}>{a}{off && <small>{off}</small>}</button>
      ))}
    </div>
  );
}
const DESTRUCTIVE = /^(Reset|Delete|Discard|Drop|Force|Remove)\b/;

/** Arrow/Home/End move focus between a menu's enabled items, wrapping at the ends. */
export function menuKeys(e: React.KeyboardEvent<HTMLElement>) {
  const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[e.key];
  if (to === undefined || !items.length) return;
  e.preventDefault();
  items[(to + items.length) % items.length].focus();
}

/** Branches, remotes, tags and stashes (Sourcetree's left sidebar). Double-click a branch to check it out. */
export function Sidebar({ path }: { path: string }) {
  const { data, error } = useQuery(refsQuery(path));
  const remoteList = useQuery(remotesQuery(path)).data;
  const log = useQuery(opLogQuery(path)).data;
  const subsList = useQuery({ queryKey: ["submodules", path], queryFn: () => submodules(path) }).data;
  const run = useRun();
  const actions = useRefActions(path);
  const paused = usePaused(path);
  // Network: may clone. `sub` null = all of them.
  const updateSub = (sub: string | null) =>
    run(() => submoduleUpdate(path, sub), sub ? `Updated ${sub}` : "Updated the submodules", sub ? `Updating ${sub}…` : "Updating submodules…");
  const [filter, setFilter] = useState("");
  // Branch drag and drop: one end must be the current branch; the drop menu offers merge/rebase with the other.
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropActions, setDropActions] = useState<Action[]>([]);
  const dropPop = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement>(null);
  // Refs load after the rail mounts: when they arrive, sections slide in from the left and the first rows cascade after.
  useGSAP(() => {
    if (!root.current) return;
    gsap.matchMedia().add(MOTION, () => {
      gsap.timeline({ defaults: { duration: 0.4, clearProps: CLEAN } })
        .from(root.current!.children, { opacity: 0, x: -14, stagger: 0.035 }, 0.05)
        .from(gsap.utils.toArray<HTMLElement>(".refs > li", root.current).slice(0, 16), { opacity: 0, x: -10, stagger: 0.015 }, 0.1);
    });
  }, { scope: root, dependencies: [!!data], revertOnUpdate: true });
  // Keep the current branch in view on open and after a switch.
  useEffect(() => { root.current?.querySelector(".refs > li.cur")?.scrollIntoView({ block: "nearest" }); }, [data?.head]);
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

  if (error) return <div className="sidebar error" role="alert">{errorText(error)}</div>;
  if (!data) return <div className="sidebar" />;
  const f = filter.trim().toLowerCase();
  const match = (items: RefItem[]) => items.filter((r) => r.name.toLowerCase().includes(f));
  // The current branch (and its upstream under its remote) goes first so it never scrolls out of sight; the rest stay alphabetical.
  const pin = (items: RefItem[], name: string | null | undefined) => {
    const i = name ? items.findIndex((r) => r.name === name) : -1;
    return i > 0 ? [items[i], ...items.slice(0, i), ...items.slice(i + 1)] : items;
  };
  const local = pin(match(data.local), data.head);
  const upstream = data.local.find((b) => b.name === data.head)?.upstream;
  // ponytail: remote name = text before the first "/"; a remote named "a/b" would be split wrong.
  // Every configured remote gets a group, even before it has branches (just added, not fetched).
  const groups = new Map<string, RefItem[]>((remoteList ?? []).map((r) => [r.name, []]));
  for (const r of match(data.remote)) {
    const name = r.name.split("/")[0];
    groups.set(name, [...(groups.get(name) ?? []), r]);
  }
  async function addRemote() {
    const v = await prompt("Add remote", "Fetch from it right after to see its branches.",
      [{ label: "Name", value: groups.size ? "" : "origin", placeholder: "upstream" }, { label: "URL", placeholder: "https://github.com/owner/repo.git" }], "Add remote", "remote", (v) => `git remote add ${v[0] || "<name>"} ${v[1] || "<url>"}`);
    if (v) run(() => remoteSet(path, v[0], v[1], false), `Added remote ${v[0]}`);
  }
  const remoteActions = (name: string): Action[] => {
    const url = remoteList?.find((r) => r.name === name)?.url ?? "";
    return [
      ["Edit URL", async () => {
        const v = await prompt(`URL of ${name}`, "", [{ label: "URL", value: url }], "Save", "remote", (v) => `git remote set-url ${name} ${v[0] || "<url>"}`);
        if (v && v[0] !== url) run(() => remoteSet(path, name, v[0], true), `${name} now points at ${v[0]}`);
      }],
      ["Remove", async () => {
        if (await confirm("Remove remote", `Remove ${name} (${url})? Its remote branches disappear here and local branches stop tracking it. Nothing changes on the server; add it again with the same URL to get it back.`, "Remove", "danger", `git remote remove ${name}`))
          run(() => remoteRemove(path, name), `Removed remote ${name}`);
      }],
    ];
  };

  // Stash names read "On main: wip" / "WIP on main: abc subject"; renaming keeps the "On main:" part.
  async function renameStash(i: number, s: RefItem) {
    const m = /^(?:WIP on|On) ([^:]+): (.*)$/s.exec(s.name);
    const v = await prompt("Rename stash", "It moves to the top of the list.", [{ label: "Name", value: m ? m[2] : s.name }], "Rename", "stash",
      (v) => `git stash store -m "${m ? `On ${m[1]}: ` : ""}${v[0]}" ${s.oid.slice(0, 7)} && git stash drop stash@{${i + 1}}`);
    if (v?.[0] && v[0] !== (m ? m[2] : s.name)) run(() => stashRename(path, i, s.oid, m ? `On ${m[1]}: ${v[0]}` : v[0]), `Renamed the stash to “${v[0]}”`);
  }
  async function branchFromStash(i: number, s: RefItem) {
    const v = await prompt("New branch from stash",
      "Starts at the commit the stash was made on, so its changes fit. The stash is applied there, then dropped.",
      [{ label: "Branch name", placeholder: "feature/…" }], "Create branch", "branch", (v) => `git stash branch ${v[0] || "<name>"} stash@{${i}}`);
    if (v?.[0]) run(() => stashBranch(path, i, s.oid, v[0]), <>Created and switched to <Local name={v[0]} /> with the stash applied</>);
  }
  async function dropStash(i: number, s: RefItem) {
    if (await confirm("Drop stash", `Drop stash "${s.name}"? Undo history (sidebar) can restore it.`, "Drop", "danger", `git stash drop stash@{${i}}`))
      run(() => stash(path, "Drop", i, s.oid));
  }

  return (
    <section ref={root} className="sidebar" aria-label="Branches">
      <label className="search"><Icon name="search" /><input type="search" placeholder="Filter" aria-label="Filter branches, tags, stashes and undo history"
        value={filter} onChange={(e) => setFilter(e.target.value)} /></label>
      <details open>
        <summary>
          <Icon name="branch" />Branches <span className="count">{data.local.length}</span>
          <button className="icon-btn" onClick={(e) => { e.preventDefault(); openNewBranch(); }} aria-label="New branch" title={paused || "New branch"} disabled={!!paused}><Icon name="add" /></button>
        </summary>
        <ul className="refs">
          {local.map((b) => {
            const cur = b.name === data.head;
            const acts = actions(b.name);
            return <Row key={b.name} item={b} cur={cur} onOpen={cur || acts[0]?.[2] ? undefined : acts[0]?.[1] /* Switch / Checkout */} actions={acts} dnd={dnd(b.name)} />;
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
              {pin(items, upstream).map((r) => (
                <Row key={r.name} item={r} label={r.name.slice(remote.length + 1)} onOpen={paused ? undefined : actions(r.name)[0][1]} actions={actions(r.name)} dnd={dnd(r.name)} />
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
          <button className="icon-btn" onClick={(e) => { e.preventDefault(); openStashSave(); }} aria-label="Stash changes…" title={paused || "Stash changes…"} disabled={!!paused}><Icon name="add" /></button>
        </summary>
        <ul className="refs">
          {data.stashes.map((s, i) => s.name.toLowerCase().includes(f) && (
            <Row key={s.oid} item={s} label={`stash@{${i}}: ${s.name}`} onPick={() => openStash(s.oid, `stash@{${i}}: ${s.name}`)} actions={blockPaused([
              ["Show changes", () => openStash(s.oid, `stash@{${i}}: ${s.name}`)],
              ["Apply", () => run(() => stash(path, "Apply", i, s.oid))],
              ["Pop", () => run(() => stash(path, "Pop", i, s.oid))],
              ["Rename", () => renameStash(i, s)],
              ["New branch from stash", () => branchFromStash(i, s)],
              ["Explain (AI)", () => openExplainStash(s.oid, `stash@{${i}}: ${s.name}`)],
              ["Drop", () => dropStash(i, s)],
            ], paused)} />
          ))}
        </ul>
      </details>
      {subsList && subsList.length > 0 && (
        <details open>
          <summary>
            <Icon name="folder" />Submodules <span className="count">{subsList.length}</span>
            <button className="icon-btn" onClick={(e) => { e.preventDefault(); updateSub(null); }} aria-label="Update all submodules"
              title="Update all: clone missing submodules and check each out at the commit this repo records"><Icon name="fetch" /></button>
          </summary>
          <ul className="refs">
            {subsList.filter((s) => s.path.toLowerCase().includes(f)).map((s) => {
              const missing = s.state === "new";
              const open = () => openRepoTab(`${path}/${s.path}`);
              return (
                <Row key={s.path} item={{ name: s.path, oid: "", upstream: null, ahead: 0, behind: 0 }}
                  label={missing ? `${s.path} · not cloned` : s.state === "moved" ? `${s.path} · needs update` : s.path}
                  onOpen={missing ? undefined : open} actions={[
                    ["Update", () => updateSub(s.path)],
                    ["Open in new tab", open, missing ? "Not cloned yet: Update first" : undefined],
                  ]} />
              );
            })}
          </ul>
        </details>
      )}
      <details>
        <summary>
          <Icon name="undo" />Undo history <span className="count">{log?.length ?? 0}</span>
          <button className="icon-btn" onClick={(e) => { e.preventDefault(); openReflog(); }} aria-label="Recover lost commits…"
            title="Recover lost commits: every place HEAD has been, also resets and rebases done outside the app"><Icon name="history" /></button>
        </summary>
        {log && (
          <ul className="refs ops">
            {log.filter((e) => opLabel(e).toLowerCase().includes(f)).map((e) => {
              const doUndo = async () => (await confirmUndo(e)) && run(() => undo(path, e.id));
              const acts: Action[] = [
                ...(canUndo(e) ? [["Undo", doUndo] as Action] : []),
                ["Delete", async () => {
                  if (await confirm("Delete from undo history", `Delete "${opLabel(e)}"? It can't be undone any more, and its backup is removed.`, "Delete", "danger"))
                    run(() => forgetOp(path, e.id));
                }],
              ];
              return <OpRow key={e.id} label={opLabel(e)} time={new Date(Number(e.id)).toLocaleString()} actions={blockPaused(acts, paused)}
                undo={canUndo(e) ? doUndo : undefined} paused={paused} />;
            })}
          </ul>
        )}
      </details>
      <RefMenu pop={dropPop} label="Drop branch" actions={dropActions} />
    </section>
  );
}

/** An undo history entry: Undo button, right-click menu (Undo, Delete). */
function OpRow({ label, time, actions, undo, paused }: { label: string; time: string; actions: Action[]; undo?: () => void; paused: string }) {
  const pop = useRef<HTMLDivElement>(null);
  return (
    <li onContextMenu={(e) => showMenu(pop.current, e)}>
      <span className="name">
        <span>{label}</span>
        <small>{time}</small>
      </span>
      {undo && <button className="small" disabled={!!paused} title={paused || undefined} onClick={undo}>Undo</button>}
      <RefMenu pop={pop} label={label} actions={actions} />
    </li>
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

/** `onPick` runs on click, `onOpen` on double-click; `actions` are [label, handler] items of a popover menu (right-click or the ⋯ button). */
type DragProps = { onDragStart: () => void; onDragEnd: () => void; canDrop: boolean; onDrop: (e: React.DragEvent<HTMLElement>) => void };
type RowProps = { item: RefItem; label?: string; cur?: boolean; onPick?: () => void; onOpen?: () => void; actions?: Action[]; dnd?: DragProps };

function Row({ item, label = item.name, cur, onPick, onOpen, actions = [], dnd }: RowProps) {
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
      <span className={onPick ? "name pick" : "name"} title={title} onClick={onPick} onDoubleClick={onOpen}>
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
  onSubmit: (name: string, checked: boolean) => void;
  onCancel: () => void;
};

/** Small inline form: one text field, optional checkbox, Esc cancels. */
export function NameForm({ label, button, check, onSubmit, onCancel }: NameFormProps) {
  const [name, setName] = useState("");
  const [on, setOn] = useState(true);
  const ok = !!name.trim();
  return (
    <form className="new-branch" onSubmit={(e) => { e.preventDefault(); if (ok) onSubmit(name.trim(), on); }}
      onKeyDown={(e) => e.key === "Escape" && onCancel()}>
      <input autoFocus aria-label={label} placeholder={label} value={name} onChange={(e) => setName(e.target.value)} />
      {check && <label className="check"><input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />{check}</label>}
      <button className="small primary" disabled={!ok}>{button}</button>
    </form>
  );
}

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { aiExplainCommit, commitDetails, commitFileDiff, createTag, merge, revert } from "../../lib/ipc";
import type { AppError } from "../../bindings/AppError";
import { DiffHead, FileLabel, Gutter, PaneNote, errorText, lineNumbers, useRun } from "../status/Changes";
import { Icon } from "../../lib/icons";
import { ago } from "../refs/NewBranch";
import { aiKeyQuery, openSettings } from "../settings/Settings";
import { NameForm, refsQuery } from "../refs/Sidebar";
import { Avatar, CommitGraph, CommitSearch, GraphOptions, savedOpts, type Picked } from "./CommitGraph";
import { Splitter } from "../../lib/splitter";
import { openRebase } from "./Rebase";
import { openFileHistory } from "./FileHistory";

const inHead = "The current branch already has this commit";

/** Commit graph on top; the picked commit's details, files and file diff below. */
export function History({ path }: { path: string }) {
  const [sel, setSel] = useState<Picked | null>(null);
  const [opts, setOpts] = useState(savedOpts);
  const [file, setFile] = useState<string | null>(null);
  const [tagging, setTagging] = useState(false);
  const [hits, setHits] = useState<Set<string>>();
  const run = useRun();
  const hasKey = useQuery(aiKeyQuery).data;
  // Explanations by oid, kept while the view is open so going back to a commit doesn't call the AI again.
  const [explained, setExplained] = useState<Record<string, string>>({});
  const [explaining, setExplaining] = useState<string | null>(null);
  async function explain(oid: string) {
    if (!hasKey) return openSettings();
    setExplaining(oid);
    await run(async () => {
      try {
        const text = await aiExplainCommit(path, oid);
        setExplained((m) => ({ ...m, [oid]: text }));
      } catch (e) {
        if ((e as AppError).code === "ai_key") openSettings();
        throw e;
      }
    });
    setExplaining(null);
  }
  const details = useQuery({ queryKey: ["commit", path, sel?.oid], queryFn: () => commitDetails(path, sel!.oid), enabled: !!sel });
  const d = details.data;
  const refs = useQuery(refsQuery(path)).data;
  const tip = refs?.local.find((b) => b.name === refs.head)?.oid;
  // Rebase rewrites commits after `d` on the current branch: none if `d` is the tip or not on it.
  const noRebase = !d ? null : d.oid === tip ? "This is the newest commit: nothing after it to rebase" : !d.in_head ? "Not on the current branch" : null;
  // Keep the picked file only while the commit has it, else show the first file.
  const shown = d?.files.find((f) => f.path === file)?.path ?? d?.files[0]?.path ?? null;
  const nl = d?.message.indexOf("\n") ?? -1;
  const subject = nl < 0 ? d?.message : d?.message.slice(0, nl);
  const body = nl < 0 ? "" : d?.message.slice(nl + 1).trim();
  // "Name <email>"
  const who = { name: d?.author.replace(/\s*<.*>$/, "") ?? "", email: d?.author.match(/<(.*)>$/)?.[1] ?? "" };
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (oid: string) => navigator.clipboard.writeText(oid).then(() => setCopied(oid), () => {});

  return (
    <div className="history-view">
      <div className="graph-wrap">
        {/* New options = new rows: drop the pick so the newest commit gets selected. */}
        <div className="graph-bar">
          <GraphOptions opts={opts} onChange={(o) => { setOpts(o); setSel(null); }} />
          <CommitSearch path={path} opts={opts} sel={sel} onSelect={setSel} onHits={setHits} />
        </div>
        <CommitGraph path={path} opts={opts} sel={sel} onSelect={setSel} hits={hits} />
      </div>
      <Splitter name="graph-h" axis="y" label="Resize commit list" />
      <div className="history-bottom">
        <section className="commit-info" key={d?.oid}>
          {details.error ? <p className="error" role="alert">{errorText(details.error)}</p> : null}
          {d && (
            <>
              <div className="ci-meta">
                <button className="sha" onClick={() => copy(d.oid)} title={`Copy ${d.oid}`} aria-label="Copy commit id">
                  {d.oid.slice(0, 7)}<Icon name={copied === d.oid ? "check" : "copy"} />
                </button>
                {d.parents.length > 1 && <span className="ci-tag">Merge</span>}
                {d.in_head && <span className="ci-tag on">On {refs?.head ?? "HEAD"}</span>}
              </div>
              <h2 className="subject">{subject}</h2>
              <div className="ci-author">
                <Avatar name={who.name} />
                <span><strong>{who.name}</strong>{who.email && <small>{who.email}</small>}</span>
                <time dateTime={new Date(d.time * 1000).toISOString()} title={new Date(d.time * 1000).toLocaleString()}>{ago(d.time)}</time>
              </div>
              <div className="commit-actions" role="toolbar" aria-label="Commit actions">
                <button className="small ghost" disabled={d.in_head} title={d.in_head ? inHead : "Copy this commit onto the current branch"} onClick={() => run(() => merge(path, d.oid, true), `Cherry-picked ${d.oid.slice(0, 7)}`)}><Icon name="pull" />Cherry-pick</button>
                <button className="small ghost" disabled={d.in_head} title={d.in_head ? inHead : undefined} onClick={() => run(() => merge(path, d.oid, false), `Merged ${d.oid.slice(0, 7)} into the current branch`)}><Icon name="branch" />Merge</button>
                <button className="small ghost" disabled={!d.in_head} title={d.in_head ? "Add a commit that undoes this one" : "Only commits on the current branch can be reverted"}
                  onClick={() => run(() => revert(path, d.oid), `Reverted ${d.oid.slice(0, 7)}`)}><Icon name="undo" />Revert</button>
                <button className="small ghost" aria-expanded={tagging} onClick={() => setTagging((t) => !t)}><Icon name="tag" />Tag…</button>
                <button className="small ghost" disabled={!!noRebase} onClick={() => openRebase(d.oid)} title={noRebase ?? "Reorder, edit, squash or drop the commits after this one"}><Icon name="restart" />Rebase…</button>
                <button className="small ghost ai" disabled={explaining === d.oid || d.oid in explained} onClick={() => explain(d.oid)}
                  title={hasKey ? "Explain this commit in plain words (message and diff sent to your AI provider)" : "Set up AI in Settings first"}>
                  <Icon name="sparkle" />{explaining === d.oid ? "Explaining…" : "Explain"}
                </button>
              </div>
              {explained[d.oid] && (
                <section className="explain" aria-label="AI explanation">
                  <h3><Icon name="sparkle" />Explanation</h3>
                  <p>{explained[d.oid]}</p>
                </section>
              )}
              {tagging && <NameForm label="Tag name" check="Annotated (message = name)" button="Create tag" onCancel={() => setTagging(false)}
                onSubmit={async (name, annotated) => { if (await run(() => createTag(path, name, d.oid, annotated ? name : ""))) setTagging(false); }} />}
              {body && <p className="message">{body}</p>}
              <dl>
                <dt>Commit</dt><dd className="mono">{d.oid}</dd>
                <dt>Parent{d.parents.length === 1 ? "" : "s"}</dt><dd className="mono">{d.parents.map((p) => p.slice(0, 7)).join("  ") || "none (first commit)"}</dd>
                {d.committer !== d.author && <><dt>Committer</dt><dd>{d.committer}</dd></>}
              </dl>
              <h3>{d.files.length} file{d.files.length === 1 ? "" : "s"} changed</h3>
              <ul className="files">
                {d.files.map((f) => {
                  const on = f.path === shown;
                  return (
                    <li key={f.path} className={on ? "sel" : undefined}>
                      <button className="row" aria-pressed={on} onClick={() => setFile(f.path)}
                        title={f.orig_path ? `${f.orig_path} → ${f.path}` : f.path}>
                        <FileLabel f={f} />
                      </button>
                      {/* A deleted file is gone in this commit: show it as of the parent. */}
                      <button className="small ghost" title={`History and blame of ${f.path}`}
                        onClick={() => openFileHistory(f.kind === "D" ? d.parents[0] : d.oid, f.path)}><Icon name="history" />History</button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>
        <Splitter name="info-w" axis="x" label="Resize commit details" />
        {d && shown ? <CommitDiff path={path} oid={d.oid} file={shown} kind={d.files.find((f) => f.path === shown)?.kind} />
          : <section className="diff">{d && <PaneNote icon="info" title="No file changes"><p>This commit changes no files.</p></PaneNote>}</section>}
      </div>
    </div>
  );
}

export function CommitDiff({ path, oid, file, kind }: { path: string; oid: string; file: string; kind?: string }) {
  // A commit never changes, so its diffs never need a refetch.
  const { data, error } = useQuery({ queryKey: ["commit-diff", path, oid, file], queryFn: () => commitFileDiff(path, oid, file) });
  const head = <DiffHead file={file} kind={kind} />;
  if (error) return <section className="diff">{head}<p className="pane-note error" role="alert">{errorText(error)}</p></section>;
  if (data === undefined) return <section className="diff">{head}</section>;
  if (data === null) return <section className="diff">{head}<PaneNote icon="info" title="No inline diff"><p>Binary file or larger than 1 MB.</p></PaneNote></section>;
  const all = data.replace(/\n$/, "").split("\n");
  const start = all.findIndex((l) => l.startsWith("@@"));
  if (start < 0) return <section className="diff">{head}<PaneNote icon="info" title="No content changes"><p>Only the mode or name changed.</p></PaneNote></section>;
  // ponytail: renders every line (≤ 1 MB file); virtualize if big diffs feel slow.
  return (
    <section className="diff">
      <DiffHead file={file} kind={kind} lines={all.slice(start)} />
      <pre key={file} aria-label={`Diff of ${file}`}>
        {lineNumbers(all, start).map(([o, n], k) => {
          const l = all[start + k];
          if (l.startsWith("@@")) return <div key={k} className="hunk"><span>{l}</span></div>;
          return <div key={k} className={l[0] === "+" ? "add" : l[0] === "-" ? "del" : undefined}><Gutter o={o} n={n} />{l || " "}</div>;
        })}
      </pre>
    </section>
  );
}

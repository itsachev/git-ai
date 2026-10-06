import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { commitDetails, commitFileDiff, createTag, merge } from "../../lib/ipc";
import { Gutter, errorText, kindClass, lineNumbers, useRun } from "../status/Changes";
import { NameForm } from "../refs/Sidebar";
import { CommitGraph, type Picked } from "./CommitGraph";
import { Splitter } from "../../lib/splitter";

/** Commit graph on top; the picked commit's details, files and file diff below. */
export function History({ path }: { path: string }) {
  const [sel, setSel] = useState<Picked | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [tagging, setTagging] = useState(false);
  const [run, opError] = useRun();
  const details = useQuery({ queryKey: ["commit", path, sel?.oid], queryFn: () => commitDetails(path, sel!.oid), enabled: !!sel });
  const d = details.data;
  // Keep the picked file only while the commit has it, else show the first file.
  const shown = d?.files.find((f) => f.path === file)?.path ?? d?.files[0]?.path ?? null;
  const nl = d?.message.indexOf("\n") ?? -1;
  const subject = nl < 0 ? d?.message : d?.message.slice(0, nl);
  const body = nl < 0 ? "" : d?.message.slice(nl + 1).trim();

  return (
    <div className="history-view">
      <CommitGraph path={path} sel={sel} onSelect={setSel} />
      <Splitter name="graph-h" axis="y" label="Resize commit list" />
      <div className="history-bottom">
        <section className="commit-info">
          {details.error ? <p className="error" role="alert">{errorText(details.error)}</p> : null}
          {d && (
            <>
              <h2 className="subject">{subject}</h2>
              {body && <p className="message">{body}</p>}
              <div className="commit-actions">
                <button className="small" onClick={() => run(() => merge(path, d.oid, true))}>Cherry-pick</button>
                <button className="small" onClick={() => run(() => merge(path, d.oid, false))}>Merge into current</button>
                <button className="small" aria-expanded={tagging} onClick={() => setTagging((t) => !t)}>Tag…</button>
              </div>
              {tagging && <NameForm label="Tag name" check="Annotated (message = name)" button="Create tag" onCancel={() => setTagging(false)}
                onSubmit={async (name, annotated) => { if (await run(() => createTag(path, name, d.oid, annotated ? name : ""))) setTagging(false); }} />}
              {opError && <p className="error" role="alert">{opError}</p>}
              <dl>
                <dt>Commit</dt><dd className="mono">{d.oid}</dd>
                <dt>Parents</dt><dd className="mono">{d.parents.map((p) => p.slice(0, 7)).join(", ") || "none"}</dd>
                <dt>Author</dt><dd>{d.author}</dd>
                <dt>Date</dt><dd>{new Date(d.time * 1000).toLocaleString()}</dd>
                {d.committer !== d.author && <><dt>Committer</dt><dd>{d.committer}</dd></>}
              </dl>
              <h3>{d.files.length} file{d.files.length === 1 ? "" : "s"}</h3>
              <ul className="files">
                {d.files.map((f) => {
                  const slash = f.path.lastIndexOf("/");
                  const on = f.path === shown;
                  return (
                    <li key={f.path} className={on ? "sel" : undefined}>
                      <button className="row" aria-pressed={on} onClick={() => setFile(f.path)}
                        title={f.orig_path ? `${f.orig_path} → ${f.path}` : f.path}>
                        <span className={`kind ${kindClass(f.kind)}`}>{f.kind}</span>
                        <span className="path">
                          <strong>{f.path.slice(slash + 1)}</strong>
                          {slash > 0 && <small>{f.path.slice(0, slash)}</small>}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>
        <Splitter name="info-w" axis="x" label="Resize commit details" />
        {d && shown && <CommitDiff path={path} oid={d.oid} file={shown} />}
      </div>
    </div>
  );
}

function CommitDiff({ path, oid, file }: { path: string; oid: string; file: string }) {
  // A commit never changes, so its diffs never need a refetch.
  const { data, error } = useQuery({ queryKey: ["commit-diff", path, oid, file], queryFn: () => commitFileDiff(path, oid, file) });
  if (error) return <section className="diff error" role="alert">{errorText(error)}</section>;
  if (data === undefined) return <section className="diff" />;
  if (data === null) return <section className="diff muted">Binary file or larger than 1 MB, no inline diff.</section>;
  const all = data.replace(/\n$/, "").split("\n");
  const start = all.findIndex((l) => l.startsWith("@@"));
  if (start < 0) return <section className="diff muted">No content changes.</section>;
  // ponytail: renders every line (≤ 1 MB file); virtualize if big diffs feel slow.
  return (
    <section className="diff">
      <pre aria-label={`Diff of ${file}`}>
        {lineNumbers(all, start).map(([o, n], k) => {
          const l = all[start + k];
          if (l.startsWith("@@")) return <div key={k} className="hunk">{l}</div>;
          return <div key={k} className={l[0] === "+" ? "add" : l[0] === "-" ? "del" : undefined}><Gutter o={o} n={n} />{l || " "}</div>;
        })}
      </pre>
    </section>
  );
}

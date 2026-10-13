import { memo, useEffect, useState } from "react";
import type { HLJSApi } from "highlight.js";

/** Diffs longer than this (chars) stay plain: every line is rendered, so colouring them would stall the main thread. */
const MAX = 200_000;

// Loaded on the first diff, so highlight.js (~150 KB) stays out of the startup bundle.
let hljs: HLJSApi | null = null;
let loading: Promise<unknown> | null = null;
const load = () => (loading ??= import("highlight.js/lib/common").then((m) => (hljs = m.default)));

/** highlight.js language for `file` (by extension, else the whole name, e.g. "Makefile"); null when unknown,
 *  while highlight.js loads, or when `diff` is too big to colour. */
export function useLang(file: string, diff: string | null | undefined) {
  const want = !!diff && diff.length <= MAX;
  const [, setReady] = useState(!!hljs);
  useEffect(() => { if (want && !hljs) load().then(() => setReady(true)); }, [want]);
  if (!want || !hljs) return null;
  const name = file.slice(file.lastIndexOf("/") + 1).toLowerCase();
  const ext = name.slice(name.lastIndexOf(".") + 1);
  return hljs.getLanguage(ext) ? ext : null;
}

/** One diff line: its +/-/space prefix, then the code coloured by `lang` (Monokai tokens in App.css). */
// ponytail: line by line, so a comment or string spanning lines is coloured only on its first; highlight whole hunks if that bothers.
export const DiffLine = memo(function DiffLine({ line, lang }: { line: string; lang: string | null }) {
  if (!lang || !hljs || !line || line[0] === "\\") return <>{line || " "}</>;
  // highlight.js escapes the code, so its HTML is safe to inject.
  const html = hljs.highlight(line.slice(1), { language: lang, ignoreIllegals: true }).value;
  return <>{line[0]}<span dangerouslySetInnerHTML={{ __html: html }} /></>;
});

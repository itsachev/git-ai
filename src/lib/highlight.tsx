import { memo } from "react";
import hljs from "highlight.js/lib/common";

/** highlight.js language for `file` (by extension, else the whole name, e.g. "Makefile"); null when unknown. */
export function langOf(file: string) {
  const name = file.slice(file.lastIndexOf("/") + 1).toLowerCase();
  const ext = name.slice(name.lastIndexOf(".") + 1);
  return hljs.getLanguage(ext) ? ext : null;
}

/** One diff line: its +/-/space prefix, then the code coloured by `lang` (Monokai tokens in App.css). */
// ponytail: line by line, so a comment or string spanning lines is coloured only on its first; highlight whole hunks if that bothers.
export const DiffLine = memo(function DiffLine({ line, lang }: { line: string; lang: string | null }) {
  if (!lang || !line || line[0] === "\\") return <>{line || " "}</>;
  // highlight.js escapes the code, so its HTML is safe to inject.
  const html = hljs.highlight(line.slice(1), { language: lang, ignoreIllegals: true }).value;
  return <>{line[0]}<span dangerouslySetInnerHTML={{ __html: html }} /></>;
});

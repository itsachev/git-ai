import { memo, useEffect, useState } from "react";
import type { HLJSApi, LanguageFn } from "highlight.js";

/** Diffs longer than this (chars) stay plain: every line is rendered, so colouring them would stall the main thread. */
const MAX = 200_000;

// Loaded on the first diff, so highlight.js (~150 KB) stays out of the startup bundle.
let hljs: HLJSApi | null = null;
let loading: Promise<unknown> | null = null;
const load = () => (loading ??= import("highlight.js/lib/common").then((m) => (hljs = m.default)));

// The ~150 languages outside the common bundle, one lazy chunk each, fetched the first time a file needs one.
const extra = import.meta.glob<{ default: LanguageFn }>(["/node_modules/highlight.js/es/languages/*.js", "!**/*.js.js"]);
const tried: Record<string, Promise<boolean>> = {};
const loadLang = (lang: string) => {
  const mod = extra[`/node_modules/highlight.js/es/languages/${lang}.js`];
  return mod ? (tried[lang] ??= mod().then((m) => (hljs!.registerLanguage(lang, m.default), true))) : Promise.resolve(false);
};

/** Extensions whose highlight.js language has another name and isn't loaded yet (so its aliases aren't known).
 *  Component files (Vue, Svelte, Astro) colour as HTML, whose <script> and <style> blocks colour as JS and CSS. */
const EXT = new Map(Object.entries({
  vue: "xml", svelte: "xml", astro: "xml", mdx: "markdown",
  ex: "elixir", exs: "elixir", erl: "erlang", hrl: "erlang", hs: "haskell", lhs: "haskell",
  clj: "clojure", cljs: "clojure", cljc: "clojure", edn: "clojure", fs: "fsharp", fsx: "fsharp", fsi: "fsharp",
  ml: "ocaml", mli: "ocaml", jl: "julia", sc: "scala", kts: "kotlin", gradle: "groovy",
  ps1: "powershell", psm1: "powershell", psd1: "powershell", bat: "dos", cmd: "dos",
  proto: "protobuf", cr: "crystal", coffee: "coffeescript", hx: "haxe", adb: "ada", ads: "ada",
  f: "fortran", f90: "fortran", f95: "fortran", pas: "delphi", dpr: "delphi", vhd: "vhdl", sv: "verilog", svh: "verilog",
  asm: "x86asm", nasm: "x86asm", scm: "scheme", ss: "scheme", rkt: "scheme", el: "lisp", lsp: "lisp",
  tex: "latex", sty: "latex", hbs: "handlebars", styl: "stylus",
  vert: "glsl", frag: "glsl",
  vb: "vbnet", vbs: "vbscript", ahk: "autohotkey",
}));

/** highlight.js language for `file` (by extension, else the whole name, e.g. "Makefile", "Dockerfile"); null when
 *  unknown, while highlight.js or the language loads, or when `diff` is too big to colour. */
export function useLang(file: string, diff: string | null | undefined) {
  const want = !!diff && diff.length <= MAX;
  const [, bump] = useState(0);
  const name = file.slice(file.lastIndexOf("/") + 1).toLowerCase();
  const ext = name.slice(name.lastIndexOf(".") + 1);
  const alt = EXT.get(ext) ?? ext;
  useEffect(() => {
    if (!want) return;
    const had = !!hljs;
    load()
      .then(() => hljs!.getLanguage(ext) || hljs!.getLanguage(alt) ? !had : loadLang(alt))
      .then((changed) => { if (changed) bump((n) => n + 1); });
  }, [want, ext, alt]);
  if (!want || !hljs) return null;
  return hljs.getLanguage(ext) ? ext : hljs.getLanguage(alt) ? alt : null;
}

/** One diff line: its +/-/space prefix, then the code coloured by `lang` (Monokai tokens in App.css). */
// ponytail: line by line, so a comment or string spanning lines is coloured only on its first; highlight whole hunks if that bothers.
export const DiffLine = memo(function DiffLine({ line, lang }: { line: string; lang: string | null }) {
  if (!lang || !hljs || !line || line[0] === "\\") return <>{line || " "}</>;
  // highlight.js escapes the code, so its HTML is safe to inject.
  const html = hljs.highlight(line.slice(1), { language: lang, ignoreIllegals: true }).value;
  return <>{line[0]}<span dangerouslySetInnerHTML={{ __html: html }} /></>;
});

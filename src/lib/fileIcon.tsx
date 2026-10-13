// File-type icons: a page outline tinted by language colour, with a glyph for the file's category. Hand-drawn on the 24x24 grid of icons.tsx.
const GLYPHS = {
  code: "M10 12l-2 2.5 2 2.5M14 12l2 2.5-2 2.5",
  data: "M10.5 11.5c-1 0-1.5.5-1.5 1.25v.5c0 .6-.4 1.25-1 1.25.6 0 1 .65 1 1.25v.5c0 .75.5 1.25 1.5 1.25M13.5 11.5c1 0 1.5.5 1.5 1.25v.5c0 .6.4 1.25 1 1.25-.6 0-1 .65-1 1.25v.5c0 .75-.5 1.25-1.5 1.25",
  text: "M8 13h8M8 16.5h5",
  markdown: "M7.5 17.5v-5l2 2.5 2-2.5v5M15 12.5v5M13.25 15.75 15 17.5l1.75-1.75",
  style: "M10.75 11.5 9.75 18M14.25 11.5l-1 6.5M8.5 13.5h7.25M8 16h7.25",
  config: "M8 13h2.5M13.5 13H16M8 17h.5M11.5 17H16M12 11.75v2.5M10 15.75v2.5",
  shell: "M8.5 12.5l2.25 2-2.25 2M12.5 17H16",
  image: "M7.5 18l3-3.25 2 2 2-2.25L17 17.5M14.5 12h.01",
  media: "M10.5 12v5l4-2.5z",
  archive: "M11 4h1M12 6h1M11 8h1M12 10h1M11 13h2v3h-2z",
  lock: "M8.5 14h7v4h-7zM10 14v-1.25a2 2 0 0 1 4 0V14",
  git: "M10 11v7M10 16c0-2 4-1.5 4-3.5M14 12.5v-.01",
  font: "M9 18l3-7 3 7M10.3 15.5h3.4",
  none: "",
} as const;
type Glyph = keyof typeof GLYPHS;

// Language colours at mid lightness, so they read on both the light and the dark panel.
const C = {
  blue: "oklch(0.6 0.14 255)", cyan: "oklch(0.66 0.11 215)", yellow: "oklch(0.72 0.15 88)", orange: "oklch(0.65 0.16 50)",
  red: "oklch(0.6 0.18 25)", pink: "oklch(0.64 0.17 350)", purple: "oklch(0.6 0.15 295)", green: "oklch(0.62 0.14 145)",
  teal: "oklch(0.62 0.1 185)", brown: "oklch(0.58 0.07 60)", grey: "oklch(0.6 0.02 260)",
};

type Kind = [Glyph, string];
const EXT: Record<string, Kind> = {};
const add = (exts: string, kind: Kind) => { for (const e of exts.split(" ")) EXT[e] = kind; };
add("ts mts cts", ["code", C.blue]);
add("tsx jsx", ["code", C.cyan]);
add("js mjs cjs", ["code", C.yellow]);
add("rs", ["code", C.orange]);
add("py pyi", ["code", C.blue]);
add("go", ["code", C.cyan]);
add("java kt kts scala groovy", ["code", C.red]);
add("c h cpp cc cxx hpp hh", ["code", C.blue]);
add("cs fs vb", ["code", C.purple]);
add("swift dart", ["code", C.orange]);
add("rb erb", ["code", C.red]);
add("php", ["code", C.purple]);
add("lua zig nim ex exs erl hs ml clj", ["code", C.purple]);
add("vue", ["code", C.green]);
add("svelte astro", ["code", C.orange]);
add("html htm xml xaml", ["code", C.orange]);
add("css", ["style", C.blue]);
add("scss sass less styl", ["style", C.pink]);
add("json jsonc json5 ndjson", ["data", C.yellow]);
add("sql prisma graphql gql proto csv tsv", ["data", C.teal]);
add("yml yaml toml ini cfg conf env properties editorconfig", ["config", C.grey]);
add("md mdx markdown", ["markdown", C.blue]);
add("txt rst log adoc", ["text", C.grey]);
add("sh bash zsh fish ps1 psm1 bat cmd", ["shell", C.green]);
add("png jpg jpeg gif webp avif bmp ico svg tif tiff psd", ["image", C.teal]);
add("mp3 wav ogg flac m4a mp4 mov webm mkv avi", ["media", C.pink]);
add("zip tar gz tgz bz2 xz 7z rar jar war", ["archive", C.brown]);
add("lock", ["lock", C.grey]);
add("ttf otf woff woff2", ["font", C.red]);
add("pdf", ["text", C.red]);

const NAMES: Record<string, Kind> = {
  ".gitignore": ["git", C.orange], ".gitattributes": ["git", C.orange], ".gitmodules": ["git", C.orange], ".gitkeep": ["git", C.orange],
  "package.json": ["data", C.red], "package-lock.json": ["lock", C.red], "cargo.toml": ["config", C.orange], "cargo.lock": ["lock", C.orange],
  dockerfile: ["config", C.blue], makefile: ["shell", C.green], license: ["text", C.yellow], readme: ["markdown", C.blue],
  ".env": ["config", C.yellow],
};

const DEFAULT: Kind = ["none", C.grey];

export function fileKind(file: string): Kind {
  const name = file.slice(file.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  // Exact name, then extension, then the name without it ("Dockerfile.dev", ".env.local").
  return NAMES[name] ?? (dot >= 0 ? EXT[name.slice(dot + 1)] : undefined) ?? (dot > 0 ? NAMES[name.slice(0, dot)] : undefined)
    ?? (name.startsWith(".env") ? NAMES[".env"] : DEFAULT);
}

/** Decorative icon for `file`'s type; the row's text names the file. */
export function FileIcon({ file }: { file: string }) {
  const [glyph, color] = fileKind(file);
  return (
    <svg className="ficon" viewBox="0 0 24 24" aria-hidden="true" style={{ "--fc": color } as React.CSSProperties}
      fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path className="ficon-page" d="M14 2H8a4 4 0 0 0-4 4v12a4 4 0 0 0 4 4h8a4 4 0 0 0 4-4V8z" />
      <path d="M14 2v2.5A3.5 3.5 0 0 0 17.5 8H20" />
      {glyph !== "none" && <path d={GLYPHS[glyph]} />}
    </svg>
  );
}

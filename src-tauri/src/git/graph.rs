//! Commit graph: lane layout over all branches, remote branches and tags.
//! Computed once per ref state (cached), then paged out to the UI.
use crate::errors::AppError;
use git2::{Oid, Repository};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use ts_rs::TS;

#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct GraphRow {
    pub oid: String,
    /// Lane of this commit's dot.
    pub col: u32,
    /// Lines from the previous row's center at lane `.0` to this row's center at lane `.1`.
    pub edges: Vec<(u32, u32)>,
    pub summary: String,
    pub author: String,
    /// Author time, seconds since the epoch.
    #[ts(type = "number")]
    pub time: i64,
    /// Short names of the branches, remote branches and tags pointing here.
    pub refs: Vec<String>,
    pub head: bool,
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct GraphPage {
    pub total: u32,
    /// Widest lane count of the whole graph.
    pub lanes: u32,
    pub rows: Vec<GraphRow>,
}

/// What the history view shows.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, TS)]
#[ts(export)]
pub struct GraphOpts {
    /// Every branch and tag; false = only what HEAD reaches.
    pub all: bool,
    /// With `all` off: only the commits not on the default branch (main/master); on the default branch itself, everything HEAD reaches.
    pub own: bool,
    /// Remote branches (as walk starts and as labels).
    pub remotes: bool,
    /// Commit date order; false = ancestor order (keeps each branch's commits together).
    pub by_date: bool,
}

struct Layout {
    repo: String,
    opts: GraphOpts,
    /// Sorted tip oids; the layout is stale once they change.
    key: Vec<Oid>,
    /// Excluded tips (`own`).
    not: Vec<Oid>,
    rows: Vec<(Oid, u32, Vec<(u32, u32)>)>,
    lanes: u32,
}

/// One cached layout (the open repo). Tauri managed state.
#[derive(Default)]
pub struct GraphCache(Mutex<Option<Layout>>);

/// Rows `offset..offset + limit`, newest first. Recomputes the layout when any ref moved.
pub fn rows(cache: &GraphCache, path: &Path, opts: GraphOpts, offset: usize, limit: usize) -> Result<GraphPage, AppError> {
    let repo = Repository::open(path)?;
    let (cache, tips, head) = fresh(cache, &repo, path, opts)?;
    let l = cache.as_ref().unwrap();

    let mut names: HashMap<Oid, Vec<String>> = HashMap::new();
    for (n, oid) in tips {
        names.entry(oid).or_default().push(n);
    }
    let rows = l.rows.iter().skip(offset).take(limit).map(|(oid, col, edges)| {
        let c = repo.find_commit(*oid)?;
        let author = c.author();
        Ok(GraphRow {
            oid: oid.to_string(),
            col: *col,
            edges: edges.clone(),
            summary: String::from_utf8_lossy(c.summary_bytes().unwrap_or_default()).into_owned(),
            author: String::from_utf8_lossy(author.name_bytes()).into_owned(),
            time: author.when().seconds(),
            refs: names.remove(oid).unwrap_or_default(),
            head: Some(*oid) == head,
        })
    });
    Ok(GraphPage { total: l.rows.len() as u32, lanes: l.lanes, rows: rows.collect::<Result<_, AppError>>()? })
}

/// Rows whose message, author name or email contains `q` (any case), or whose id starts with it: (row, oid), newest first.
pub fn search(cache: &GraphCache, path: &Path, opts: GraphOpts, q: &str) -> Result<Vec<(u32, String)>, AppError> {
    let q = q.trim().to_lowercase();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let repo = Repository::open(path)?;
    // Copy the oids out so paging isn't blocked while this runs.
    let oids: Vec<Oid> = fresh(cache, &repo, path, opts)?.0.as_ref().unwrap().rows.iter().map(|r| r.0).collect();
    let has = |b: &[u8]| String::from_utf8_lossy(b).to_lowercase().contains(&q);
    // ponytail: parses every commit per search (~1 s per 100k); keep messages in the layout if that's slow.
    let mut hits = vec![];
    for (i, oid) in oids.into_iter().enumerate() {
        let id = oid.to_string();
        let c = repo.find_commit(oid)?;
        let a = c.author();
        if id.starts_with(&q) || has(c.message_bytes()) || has(a.name_bytes()) || has(a.email_bytes()) {
            hits.push((i as u32, id));
        }
    }
    Ok(hits)
}

/// The cached layout for `opts`, recomputed when the repo, the options or any ref changed. Also the tips and HEAD.
fn fresh<'a>(
    cache: &'a GraphCache,
    repo: &Repository,
    path: &Path,
    opts: GraphOpts,
) -> Result<(MutexGuard<'a, Option<Layout>>, Vec<(String, Oid)>, Option<Oid>), AppError> {
    let tips = tips(repo, opts.remotes);
    let head = repo.head().ok().and_then(|h| h.target());
    let starts: &[_] = if opts.all { &tips } else { &[] };
    let mut key: Vec<Oid> = starts.iter().map(|t| t.1).chain(head).collect();
    key.sort();
    key.dedup();
    let not = if !opts.all && opts.own { default_tips(repo) } else { vec![] };
    let name = path.to_string_lossy().into_owned();
    let mut cache = cache.0.lock().unwrap_or_else(|e| e.into_inner());
    if !matches!(&*cache, Some(l) if l.repo == name && l.opts == opts && l.key == key && l.not == not) {
        *cache = Some(compute(path, name, opts, key, not)?);
    }
    Ok((cache, tips, head))
}

/// (short name, commit) for every branch, remote branch (if `remotes`) and tag. Tags are peeled to their commit.
fn tips(repo: &Repository, remotes: bool) -> Vec<(String, Oid)> {
    let Ok(refs) = repo.references() else { return vec![] };
    let prefixes: &[&str] = if remotes { &["refs/heads/", "refs/remotes/", "refs/tags/"] } else { &["refs/heads/", "refs/tags/"] };
    refs.flatten()
        .filter(|r| r.name().is_ok_and(|n| prefixes.iter().any(|p| n.starts_with(p))))
        .filter(|r| r.name().is_ok_and(|n| !n.ends_with("/HEAD"))) // origin/HEAD duplicates origin/main
        .filter_map(|r| Some((r.shorthand().ok()?.to_string(), r.peel_to_commit().ok()?.id())))
        .collect()
}

/// Tips of the default branch (origin/HEAD's name, else main, else master), local and on origin.
/// Empty when HEAD is on it, so "own commits" there shows the whole branch.
fn default_tips(repo: &Repository) -> Vec<Oid> {
    let remote = repo.find_reference("refs/remotes/origin/HEAD").ok();
    let target = remote.as_ref().and_then(|r| r.symbolic_target().ok().flatten()).and_then(|t| t.strip_prefix("refs/remotes/origin/"));
    let has = |n: &str| ["refs/heads/", "refs/remotes/origin/"].iter().any(|p| repo.find_reference(&format!("{p}{n}")).is_ok());
    let Some(name) = target.map(str::to_string).or_else(|| ["main", "master"].into_iter().find(|n| has(n)).map(String::from)) else { return vec![] };
    if repo.head().ok().and_then(|h| h.shorthand().ok().map(String::from)).as_deref() == Some(name.as_str()) {
        return vec![];
    }
    ["refs/heads/", "refs/remotes/origin/"]
        .iter()
        .filter_map(|p| repo.find_reference(&format!("{p}{name}")).ok()?.peel_to_commit().ok().map(|c| c.id()))
        .collect()
}

/// The walk runs the `git` binary, an exception to "reads use git2": it reads the commit-graph file
/// and libgit2 doesn't (85k commits: 0.25 s vs 1.45 s for walk + layout).
fn compute(path: &Path, name: String, opts: GraphOpts, key: Vec<Oid>, not: Vec<Oid>) -> Result<Layout, AppError> {
    let mut commits: Vec<(Oid, Vec<Oid>)> = vec![];
    if !key.is_empty() {
        // Tips go in on stdin: thousands of tags would overflow the Windows command line (32k chars).
        let order = if opts.by_date { "--date-order" } else { "--topo-order" };
        let tips: String = key.iter().map(|o| format!("{o}\n")).chain(not.iter().map(|o| format!("^{o}\n"))).collect();
        let out = crate::git::cli::git_input(path, &["rev-list", "--parents", order, "--stdin"], &tips)?;
        for line in out.lines() {
            let mut ids = line.split(' ').map(Oid::from_str);
            let Some(Ok(id)) = ids.next() else { continue };
            commits.push((id, ids.collect::<Result<_, _>>()?));
        }
    }
    let (cols, lanes) = layout(&commits);
    let rows = commits.into_iter().zip(cols).map(|((oid, _), (col, edges))| (oid, col, edges)).collect();
    Ok(Layout { repo: name, opts, key, not, rows, lanes })
}

/// Assigns each commit (children before parents) a lane, plus the edges coming into its row.
/// Returns (col, edges) per commit and the widest lane count.
fn layout<T: Copy + PartialEq>(commits: &[(T, Vec<T>)]) -> (Vec<(u32, Vec<(u32, u32)>)>, u32) {
    /// A lane waits for commit `want`; `from` are the lanes in the previous row its lines start at.
    struct Lane<T> {
        want: T,
        from: Vec<u32>,
    }
    fn free<L>(lanes: &mut Vec<Option<L>>) -> usize {
        lanes.iter().position(Option::is_none).unwrap_or_else(|| {
            lanes.push(None);
            lanes.len() - 1
        })
    }
    // ponytail: a parent missing from the walk (shallow clone) keeps its lane open to the bottom.
    let mut lanes: Vec<Option<Lane<T>>> = vec![];
    let mut out = Vec::with_capacity(commits.len());
    let mut width = 0;
    for (id, parents) in commits {
        let hits: Vec<usize> = (0..lanes.len()).filter(|&j| lanes[j].as_ref().is_some_and(|l| l.want == *id)).collect();
        let col = hits.first().copied().unwrap_or_else(|| free(&mut lanes));
        let mut edges = vec![];
        for (j, lane) in lanes.iter_mut().enumerate() {
            let Some(l) = lane else { continue };
            let to = if l.want == *id { col } else { j } as u32;
            edges.extend(l.from.iter().map(|&f| (f, to)));
            l.from.clear(); // reuse the buffer: one allocation per lane per row was 2/3 of the layout time
            l.from.push(j as u32);
        }
        for j in hits {
            lanes[j] = None;
        }
        for (k, p) in parents.iter().enumerate() {
            if let Some(l) = lanes.iter_mut().flatten().find(|l| l.want == *p) {
                l.from.push(col as u32);
                continue;
            }
            let slot = if k == 0 && lanes[col].is_none() { col } else { free(&mut lanes) };
            lanes[slot] = Some(Lane { want: *p, from: vec![col as u32] });
        }
        while matches!(lanes.last(), Some(None)) {
            lanes.pop();
        }
        width = width.max(lanes.len()).max(col + 1);
        out.push((col as u32, edges));
    }
    (out, width as u32)
}

#[cfg(test)]
mod tests {
    use super::layout;

    #[test]
    fn lays_out_lanes() {
        // c - b - a: one straight lane.
        let (rows, w) = layout(&[(3, vec![2]), (2, vec![1]), (1, vec![])]);
        assert_eq!(rows, vec![(0, vec![]), (0, vec![(0, 0)]), (0, vec![(0, 0)])]);
        assert_eq!(w, 1);
        // m merges x and y, both branched off base.
        let (rows, w) = layout(&[(4, vec![2, 3]), (2, vec![1]), (3, vec![1]), (1, vec![])]);
        assert_eq!(
            rows,
            vec![(0, vec![]), (0, vec![(0, 0), (0, 1)]), (1, vec![(0, 0), (1, 1)]), (0, vec![(0, 0), (1, 0)])]
        );
        assert_eq!(w, 2);
        // Two unrelated tips: the second starts its own lane.
        let (rows, _) = layout(&[(2, vec![1]), (9, vec![1]), (1, vec![])]);
        assert_eq!(rows, vec![(0, vec![]), (1, vec![(0, 0)]), (0, vec![(0, 0), (1, 0)])]);
    }

    /// Remotes toggle and the two sort orders, on a real repo.
    #[test]
    fn options() {
        use super::{rows, GraphCache, GraphOpts};
        let dir = std::env::temp_dir().join(format!("git-ai-opts-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let repo = git2::Repository::init(&dir).unwrap();
        let tree = repo.find_tree(repo.treebuilder(None).unwrap().write().unwrap()).unwrap();
        let at = |r: &str, msg: &str, t: i64, parents: &[git2::Oid]| {
            let sig = git2::Signature::new("T", "t@t", &git2::Time::new(t, 0)).unwrap();
            let ps: Vec<_> = parents.iter().map(|p| repo.find_commit(*p).unwrap()).collect();
            repo.commit(Some(r), &sig, &sig, msg, &tree, &ps.iter().collect::<Vec<_>>()).unwrap()
        };
        // base, then a1 b1 a2 b2 interleaved in time on branches a (HEAD) and b; origin/x on its own.
        let base = at("refs/heads/a", "base", 100, &[]);
        let a1 = at("refs/heads/a", "a1", 200, &[base]);
        let b1 = at("refs/heads/b", "b1", 300, &[base]);
        let a2 = at("refs/heads/a", "a2", 400, &[a1]);
        at("refs/heads/b", "b2", 500, &[b1]);
        let x = at("refs/remotes/origin/x", "x", 600, &[a2]);
        repo.set_head("refs/heads/a").unwrap();
        let on = GraphOpts { all: true, remotes: true, own: false, by_date: true };
        let order = |o| rows(&GraphCache::default(), &dir, o, 0, 100).unwrap().rows.into_iter().map(|r| r.summary).collect::<Vec<_>>();
        assert_eq!(order(on), ["x", "b2", "a2", "b1", "a1", "base"]);
        let page = rows(&GraphCache::default(), &dir, on, 0, 100).unwrap();
        assert!(page.rows[0].refs == ["origin/x"]);
        // Remotes off: x is gone as a row and as a label.
        let off = GraphOpts { remotes: false, ..on };
        assert_eq!(order(off), ["b2", "a2", "b1", "a1", "base"]);
        // Ancestor order keeps each branch's commits together.
        let topo = order(GraphOpts { by_date: false, ..off });
        eprintln!("ancestor order: {topo:?}");
        let pos = |m: &str| topo.iter().position(|s| s == m).unwrap();
        assert!(pos("b2") + 1 == pos("b1") && pos("a2") + 1 == pos("a1"), "{topo:?}");
        // Same cache, options flipped: no stale layout.
        let cache = GraphCache::default();
        assert_eq!(rows(&cache, &dir, on, 0, 100).unwrap().total, 6);
        assert_eq!(rows(&cache, &dir, off, 0, 100).unwrap().total, 5);
        assert_eq!(rows(&cache, &dir, GraphOpts { all: false, ..off }, 0, 100).unwrap().total, 3);
        // Own commits: a minus main (at base); on main itself, everything HEAD reaches.
        repo.reference("refs/heads/main", base, false, "").unwrap();
        let own = GraphOpts { all: false, own: true, ..off };
        assert_eq!(order(own), ["a2", "a1"]);
        repo.set_head("refs/heads/main").unwrap();
        assert_eq!(order(own), ["base"]);
        repo.set_head("refs/heads/a").unwrap();
        // Search: message, author, id prefix; rows match the page order.
        let find = |q: &str| super::search(&cache, &dir, on, q).unwrap().into_iter().map(|h| h.0).collect::<Vec<_>>();
        assert_eq!(find("A2"), [2]);
        assert_eq!(find("t@T").len(), 6);
        assert_eq!(find(&x.to_string()[..7]), [0]);
        assert!(find("  ").is_empty() && find("nope").is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 100k commits (main + a 3-commit topic branch merged every 50), timed.
    /// `cargo test --release --manifest-path src-tauri/Cargo.toml big_graph -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn big_graph() {
        use std::io::Write;
        use std::time::Instant;
        let dir = std::env::temp_dir().join(format!("git-ai-big-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        git2::Repository::init(&dir).unwrap();
        let (mut s, mut mark, mut main) = (String::new(), 0, 0);
        let mut commit = |s: &mut String, branch: &str, from: u32, merge: Option<u32>| {
            mark += 1;
            let t = 1_000_000_000 + mark as u64 * 60;
            s.push_str(&format!("commit refs/heads/{branch}\nmark :{mark}\ncommitter A <a@a> {t} +0000\ndata 4\nc{:03}\n", mark % 1000));
            if from > 0 {
                s.push_str(&format!("from :{from}\n"));
            }
            if let Some(m) = merge {
                s.push_str(&format!("merge :{m}\n"));
            }
            mark
        };
        while main < 100_000 {
            main = commit(&mut s, "main", main, None);
            if main % 50 == 0 {
                let mut f = main;
                for _ in 0..3 {
                    f = commit(&mut s, "topic", f, None);
                }
                main = commit(&mut s, "main", main, Some(f));
            }
        }
        let mut imp = std::process::Command::new("git").arg("-C").arg(&dir).args(["fast-import", "--quiet"])
            .stdin(std::process::Stdio::piped()).spawn().unwrap();
        imp.stdin.take().unwrap().write_all(s.as_bytes()).unwrap();
        assert!(imp.wait().unwrap().success());

        let cache = super::GraphCache::default();
        let all = super::GraphOpts { all: true, remotes: true, own: false, by_date: true };
        let t = Instant::now();
        let page = super::rows(&cache, &dir, all, 0, 500).unwrap();
        eprintln!("first page (layout + 500 rows): {:?}, total {}, lanes {}", t.elapsed(), page.total, page.lanes);
        assert!(page.total >= 100_000);
        let t = Instant::now();
        super::rows(&cache, &dir, all, 60_000, 500).unwrap();
        eprintln!("cached page at 60k: {:?}", t.elapsed());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

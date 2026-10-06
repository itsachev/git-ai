//! Commit graph: lane layout over all branches, remote branches and tags.
//! Computed once per ref state (cached), then paged out to the UI.
use crate::errors::AppError;
use git2::{Oid, Repository};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
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

struct Layout {
    repo: String,
    /// Sorted tip oids; the layout is stale once they change.
    key: Vec<Oid>,
    rows: Vec<(Oid, u32, Vec<(u32, u32)>)>,
    lanes: u32,
}

/// One cached layout (the open repo). Tauri managed state.
#[derive(Default)]
pub struct GraphCache(Mutex<Option<Layout>>);

/// Rows `offset..offset + limit`, newest first. Recomputes the layout when any ref moved.
pub fn rows(cache: &GraphCache, path: &Path, offset: usize, limit: usize) -> Result<GraphPage, AppError> {
    let repo = Repository::open(path)?;
    let tips = tips(&repo);
    let head = repo.head().ok().and_then(|h| h.target());
    let mut key: Vec<Oid> = tips.iter().map(|t| t.1).chain(head).collect();
    key.sort();
    key.dedup();
    let name = path.to_string_lossy().into_owned();

    let mut cache = cache.0.lock().unwrap_or_else(|e| e.into_inner());
    if !matches!(&*cache, Some(l) if l.repo == name && l.key == key) {
        *cache = Some(compute(&repo, name, key)?);
    }
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

/// (short name, commit) for every branch, remote branch and tag. Tags are peeled to their commit.
fn tips(repo: &Repository) -> Vec<(String, Oid)> {
    let Ok(refs) = repo.references() else { return vec![] };
    refs.flatten()
        .filter(|r| r.name().is_ok_and(|n| ["refs/heads/", "refs/remotes/", "refs/tags/"].iter().any(|p| n.starts_with(p))))
        .filter(|r| r.name().is_ok_and(|n| !n.ends_with("/HEAD"))) // origin/HEAD duplicates origin/main
        .filter_map(|r| Some((r.shorthand().ok()?.to_string(), r.peel_to_commit().ok()?.id())))
        .collect()
}

fn compute(repo: &Repository, name: String, key: Vec<Oid>) -> Result<Layout, AppError> {
    let mut walk = repo.revwalk()?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)?;
    for oid in &key {
        walk.push(*oid)?;
    }
    // ponytail: parses every commit (~1 s per 100k); read the commit-graph file if that gets slow.
    let commits = walk
        .map(|oid| {
            let c = repo.find_commit(oid?)?;
            Ok((c.id(), c.parent_ids().collect()))
        })
        .collect::<Result<Vec<_>, git2::Error>>()?;
    let (cols, lanes) = layout(&commits);
    let rows = commits.into_iter().zip(cols).map(|((oid, _), (col, edges))| (oid, col, edges)).collect();
    Ok(Layout { repo: name, key, rows, lanes })
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
            l.from = vec![j as u32];
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
        let t = Instant::now();
        let page = super::rows(&cache, &dir, 0, 500).unwrap();
        eprintln!("first page (layout + 500 rows): {:?}, total {}, lanes {}", t.elapsed(), page.total, page.lanes);
        assert!(page.total >= 100_000);
        let t = Instant::now();
        super::rows(&cache, &dir, 60_000, 500).unwrap();
        eprintln!("cached page at 60k: {:?}", t.elapsed());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

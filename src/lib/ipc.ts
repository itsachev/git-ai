import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { RepoInfo } from "../bindings/RepoInfo";
import type { Status } from "../bindings/Status";
import type { LineOp } from "../bindings/LineOp";
import type { OpEntry } from "../bindings/OpEntry";
import type { GraphPage } from "../bindings/GraphPage";
import type { AiConfig } from "../bindings/AiConfig";
import type { GraphOpts } from "../bindings/GraphOpts";
import type { CommitDetails } from "../bindings/CommitDetails";
import type { Refs } from "../bindings/Refs";
import type { StashOp } from "../bindings/StashOp";
import type { Side } from "../bindings/Side";
import type { Editors } from "../bindings/Editors";
import type { DeviceCode } from "../bindings/DeviceCode";
import type { RebaseCommit } from "../bindings/RebaseCommit";
import type { RebaseStep } from "../bindings/RebaseStep";
import type { FileCommit } from "../bindings/FileCommit";
import type { Blame } from "../bindings/Blame";
import type { GitSetup } from "../bindings/GitSetup";
import type { GhRepo } from "../bindings/GhRepo";
import type { Lfs } from "../bindings/Lfs";
import type { Remote } from "../bindings/Remote";

// Rejections get a `title` naming what failed ("Failed to check out main"), shown by OpErrorDialog.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = any;
const short = (rev: string) => (/^[0-9a-f]{40}$/.test(rev) ? rev.slice(0, 7) : rev);
const FAILED: Record<string, (a: Args) => string> = {
  stage: () => "Failed to stage changes",
  unstage: () => "Failed to unstage changes",
  discard: () => "Failed to discard changes",
  commit: (a) => (a.amend ? "Failed to amend the commit" : "Failed to commit"),
  apply_lines: () => "Failed to update the selected lines",
  undo: () => "Failed to undo",
  checkout: (a) => `Failed to check out ${a.name}`,
  create_branch: (a) => `Failed to create branch ${a.name}`,
  delete_branch: (a) => `Failed to delete branch ${a.name}`,
  merge: (a) => (a.cherryPick ? `Failed to cherry-pick ${short(a.rev)}` : `Failed to merge ${short(a.rev)}`),
  abort: () => "Failed to abort",
  rebase_commits: () => "Can't rebase from this commit",
  rebase: () => "Rebase failed",
  file_log: (a) => `Failed to load the history of ${a.file}`,
  blame: (a) => `Failed to blame ${a.file}`,
  create_tag: (a) => `Failed to create tag ${a.name}`,
  delete_tag: (a) => `Failed to delete tag ${a.name}`,
  stash_save: () => "Failed to stash changes",
  stash: (a) => `Failed to ${a.op.toLowerCase()} stash`,
  fetch: () => "Fetch failed",
  pull: () => "Pull failed",
  push: () => "Push failed",
  push_tag: (a) => `Failed to push tag ${a.name}`,
  delete_remote_branch: (a) => `Failed to delete ${a.name} on the remote`,
  resolve: () => "Failed to resolve the conflict",
  write_resolved: (a) => `Failed to apply the resolution to ${a.file}`,
  ai_resolve_conflict: (a) => `Failed to resolve ${a.file} with AI`,
  open_file: (a) => `Failed to open ${a.file}`,
  lfs_track: (a) => (a.track ? `Failed to track ${a.pattern} with LFS` : `Failed to untrack ${a.pattern}`),
  lfs_pull: () => "Failed to download LFS files",
  forget_repo: () => "Failed to remove the repository",
  trash_repo: () => "Failed to delete the repository",
  ai_set_key: () => "Failed to save the API key",
  reset_to: (a) => `Failed to reset to ${a.rev}`,
  revert: (a) => `Failed to revert ${short(a.rev)}`,
  rename_branch: (a) => `Failed to rename ${a.name}`,
  set_upstream: (a) => `Failed to change what ${a.branch} tracks`,
  remote_set: (a) => (a.edit ? `Failed to change the URL of ${a.name}` : `Failed to add remote ${a.name}`),
  remote_remove: (a) => `Failed to remove remote ${a.name}`,
  ignore: (a) => `Failed to ignore ${a.pattern}`,
  init_repo: () => "Failed to create the repository",
  ai_commit_message: () => "Failed to write a commit message",
  ai_explain_commit: (a) => `Failed to explain ${short(a.oid)}`,
  create_pr: () => "Failed to open the pull request",
  ai_explain_stash: () => "Failed to explain the stash",
  ai_write_range: (a) => a.kind === "pr" ? "Failed to write a PR description" : a.kind === "explain" ? "Failed to explain the branch" : "Failed to write a changelog",
};
async function invoke<T>(cmd: string, args?: Args): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (e) {
    const title = FAILED[cmd]?.(args);
    throw title && typeof e === "object" && e ? { ...e, title } : e;
  }
}

export const openRepo = (path: string) => invoke<RepoInfo>("open_repo", { path });
export const recentRepos = () => invoke<string[]>("recent_repos");
export const missingRepos = () => invoke<string[]>("missing_repos");
/** Drops a repo from the recent list; the folder stays. */
export const forgetRepo = (path: string) => invoke<void>("forget_repo", { path });
/** Moves a recent repo's folder to the OS trash and forgets it. */
export const trashRepo = (path: string) => invoke<void>("trash_repo", { path });
export const repoStatus = (path: string) => invoke<Status>("repo_status", { path });
export const stage = (path: string, paths: string[]) => invoke<void>("stage", { path, paths });
export const unstage = (path: string, paths: string[]) => invoke<void>("unstage", { path, paths });
export const discard = (path: string, paths: string[]) => invoke<void>("discard", { path, paths });
/** A note when a rebase dropped the commit (the resolution changed nothing), else null. */
export const commit = (path: string, message: string, amend: boolean) => invoke<string | null>("commit", { path, message, amend });
/** null before the first commit. */
export const headMessage = (path: string) => invoke<string | null>("head_message", { path });
/** `lines` index into the lines of the file's `fileDiff` text. */
export const applyLines = (path: string, file: string, op: LineOp, lines: number[]) =>
  invoke<void>("apply_lines", { path, file, op, lines });
/** Newest first, already-undone entries left out. */
export const opLog = (path: string) => invoke<OpEntry[]>("op_log", { path });
export const undo = (path: string, id: string) => invoke<void>("undo", { path, id });
/** null = binary or over 1 MB. */
export const fileDiff = (path: string, file: string, staged: boolean) =>
  invoke<string | null>("file_diff", { path, file, staged });
/** Graph rows `offset..offset + limit`, newest first. */
export const graphRows = (path: string, opts: GraphOpts, offset: number, limit: number) =>
  invoke<GraphPage>("graph_rows", { path, opts, offset, limit });
export const commitDetails = (path: string, oid: string) => invoke<CommitDetails>("commit_details", { path, oid });
/** null = binary or over 1 MB. */
export const commitFileDiff = (path: string, oid: string, file: string) =>
  invoke<string | null>("commit_file_diff", { path, oid, file });
export const refs = (path: string) => invoke<Refs>("refs", { path });
/** `track`: create a local branch tracking remote branch `name` ("origin/feat") and switch to it.
 * Code "dirty" = local changes in the way; `carry` stashes them, switches and pops them back
 * (code "conflicts" = they clash with the branch and stay stashed). */
export const checkout = (path: string, name: string, track: boolean, carry = false) =>
  invoke<void>("checkout", { path, name, track, carry });
/** `from`: start point (branch, remote branch, tag); null = HEAD. Never tracks `from`. */
export const createBranch = (path: string, name: string, from: string | null, checkout: boolean) =>
  invoke<void>("create_branch", { path, name, from, checkout });
/** Fails with code "not_merged" unless `force`. Undoable via the op log. */
export const deleteBranch = (path: string, name: string, force: boolean) => invoke<void>("delete_branch", { path, name, force });
/** Merges `rev` into the current branch, or with `cherryPick` applies that one commit. Code "conflicts" = stopped halfway. */
export const merge = (path: string, rev: string, cherryPick: boolean) => invoke<void>("merge", { path, rev, cherryPick });
/** Rebases the current branch onto `onto`. Code "conflicts" = paused, continue from File Status. Undoable. */
/** Moves the current branch to `rev` (reset --keep); undoable. */
export const resetTo = (path: string, rev: string) => invoke<void>("reset_to", { path, rev });
export const rebaseOnto =(path: string, onto: string) => invoke<void>("rebase_onto", { path, onto });
/** Adds a commit undoing `rev` (a merge against its first parent). Code "conflicts" = stopped halfway. Undoable. */
export const revert = (path: string, rev: string) => invoke<void>("revert", { path, rev });
export const renameBranch = (path: string, name: string, newName: string) => invoke<void>("rename_branch", { path, name, newName });
/** `upstream`: remote branch like "origin/main"; null stops tracking. */
export const setUpstream = (path: string, branch: string, upstream: string | null) => invoke<void>("set_upstream", { path, branch, upstream });
export const remotes = (path: string) => invoke<Remote[]>("remotes", { path });
/** Adds remote `name`, or with `edit` changes its URL. */
export const remoteSet = (path: string, name: string, url: string, edit: boolean) => invoke<void>("remote_set", { path, name, url, edit });
/** Removes the remote and its remote branches. */
export const remoteRemove = (path: string, name: string) => invoke<void>("remote_remove", { path, name });
/** Appends a pattern to the top-level .gitignore; left unstaged. */
export const ignore = (path: string, pattern: string) => invoke<void>("ignore", { path, pattern });
/** `git init` in `dir` (made if missing), then opens it. */
export const initRepo = (dir: string) => invoke<RepoInfo>("init_repo", { dir });
/** Aborts the in-progress merge/cherry-pick (changed files backed up first). */
export const abortOp = (path: string) => invoke<void>("abort", { path });
/** Commits after `base` on the current branch, oldest first. Codes "has_merges", "too_many", "not_ancestor". */
export const rebaseCommits = (path: string, base: string) => invoke<RebaseCommit[]>("rebase_commits", { path, base });
/** Rewrites the commits after `base` as `steps` (all of them, oldest first). Code "conflicts" = stopped; commit continues it. Undoable. */
export const rebase = (path: string, base: string, steps: RebaseStep[]) => invoke<void>("rebase", { path, base, steps });
/** Commits from `rev` back that changed `file`, newest first, following renames (at most 2000). */
export const fileLog = (path: string, rev: string, file: string) => invoke<FileCommit[]>("file_log", { path, rev, file });
/** Who last changed each line of `file` at `rev`; text null = binary or over 1 MB. */
export const blame = (path: string, rev: string, file: string) => invoke<Blame>("blame", { path, rev, file });
/** Annotated when `message` isn't empty. */
export const createTag = (path: string, name: string, target: string, message: string) =>
  invoke<void>("create_tag", { path, name, target, message });
export const deleteTag = (path: string, name: string) => invoke<void>("delete_tag", { path, name });
/** Stashes all changes, untracked files included. */
export const stashSave = (path: string, message: string) => invoke<void>("stash_save", { path, message });
/** `oid` must still be stash@{index}, else code "stale". */
export const stash = (path: string, op: StashOp, index: number, oid: string) => invoke<void>("stash", { path, op, index, oid });
// Network ops. git may ask for credentials meanwhile through the "askpass" event (see AskpassDialog).
export const fetchAll = (path: string) => invoke<void>("fetch", { path });
/** Merges the upstream, or with `rebase` replays local commits on it; code "conflicts" = stopped halfway. Undoable. */
export const pull = (path: string, rebase = false) => invoke<void>("pull", { path, rebase });
/** Pushes the current branch; without an upstream it goes to origin and becomes the upstream. Code "rejected" = pull first. */
export const push = (path: string) => invoke<void>("push", { path });
export const pushTag = (path: string, name: string) => invoke<void>("push_tag", { path, name });
/** `name` is the remote branch, e.g. "origin/feat". Undo pushes it back. */
export const deleteRemoteBranch = (path: string, name: string) => invoke<void>("delete_remote_branch", { path, name });
/** Clones `url` into `dest` (missing or empty folder) and opens it. Progress comes as "clone-progress" events (git's lines). */
export const cloneRepo = (url: string, dest: string) => invoke<RepoInfo>("clone_repo", { url, dest });
/** Takes one side of each conflicted file whole (backed up first, undoable) and marks it resolved. */
export const resolve = (path: string, paths: string[], side: Side) => invoke<void>("resolve", { path, paths, side });
/** Writes `text` over a conflicted file (backed up first, undoable) and marks it resolved. */
export const writeResolved = (path: string, file: string, text: string) => invoke<void>("write_resolved", { path, file, text });
/** Working-tree text of a file; null = binary or over 1 MB. */
export const workFile = (path: string, file: string) => invoke<string | null>("work_file", { path, file });
/** Opens a repo file in `editor` (a name from `editors()`), or its default app when null. Remembers the choice. */
export const openFile = (path: string, file: string, editor: string | null) => invoke<void>("open_file", { path, file, editor });
/** Installed editors and the last one used. */
export const editors = () => invoke<Editors>("editors");
/** Answers an "askpass" prompt; null cancels (git then fails). */
export const askpassReply = (id: number, answer: string | null) => invoke<void>("askpass_reply", { id, answer });
// GitHub sign-in (OAuth device flow). The token stays in the OS keychain; git gets it via askpass.
export const githubStart = () => invoke<DeviceCode>("github_start");
/** Resolves with the login once the user approves `code` on GitHub; code "expired" / "denied" otherwise. */
export const githubFinish = (code: DeviceCode) => invoke<string>("github_finish", { code });
/** null = signed out. */
export const githubUser = () => invoke<string | null>("github_user");
/** Repos the signed-in user can clone, most recently pushed first; [] when signed out. */
export const githubRepos = () => invoke<GhRepo[]>("github_repos");
/** Pushes `head` ("" = current branch; a remote branch is used as is), then opens a GitHub PR or GitLab MR into `base`.
 * Returns its web URL. Codes "signed_out", "not_hosted", "not_branch", "github"/"gitlab" (refused, e.g. one already exists). */
export const createPr = (path: string, head: string, base: string, title: string, body: string) =>
  invoke<string>("create_pr", { path, head, base, title, body });
/** Host of the default remote: "github", "gitlab" or null (elsewhere, or no remote). */
export const prProvider = (path: string) => invoke<"github" | "gitlab" | null>("pr_provider", { path });
export const githubSignOut =() => invoke<void>("github_sign_out");
// GitLab (gitlab.com) sign-in, same device flow and calls as GitHub's. Code "gitlab" when the build has no client id.
export const gitlabStart = () => invoke<DeviceCode>("gitlab_start");
export const gitlabFinish = (code: DeviceCode) => invoke<string>("gitlab_finish", { code });
export const gitlabUser = () => invoke<string | null>("gitlab_user");
export const gitlabRepos = () => invoke<GhRepo[]>("gitlab_repos");
export const gitlabSignOut = () => invoke<void>("gitlab_sign_out");
// SSH key used for fetch/pull/push/clone. null = ssh's defaults (~/.ssh/id_*, ssh-agent).
export const sshKey = () => invoke<string | null>("ssh_key");
/** null clears it. Code "ssh_key" when the file isn't a readable private key. */
export const sshKeySet = (path: string | null) => invoke<void>("ssh_key_set", { path });
/** Private keys found in ~/.ssh, default names first. */
export const sshDetect = () => invoke<string[]>("ssh_detect");
// Global git setup (identity, credential helper) and the first-run wizard flag.
export const gitSetup = () => invoke<GitSetup>("git_setup");
/** helper: also turn on the OS credential helper if none is set. */
export const gitSetupSet = (name: string, email: string, helper: boolean) => invoke<void>("git_setup_set", { name, email, helper });
export const setupDone = () => invoke<boolean>("setup_done");
export const setupFinish = () => invoke<void>("setup_finish");
// AI, bring your own key: Gemini, Claude or an OpenAI-compatible server. Keys stay in the OS keychain (or <PROVIDER>_API_KEY in dev).
export const aiConfig = () => invoke<AiConfig>("ai_config");
export const aiSetConfig = (config: AiConfig) => invoke<void>("ai_set_config", { config });
/** True when the chosen provider has a key, or needs none (a custom OpenAI-compatible URL). */
export const aiHasKey = () => invoke<boolean>("ai_has_key");
/** null removes the stored key. */
export const aiSetKey = (provider: string, key: string | null) => invoke<void>("ai_set_key", { provider, key });
/** Writes a commit message from the staged diff (sent to the AI provider). Codes: "ai_no_key", "ai_key" (rejected), "ai_limit", "nothing_staged". */
export const aiCommitMessage = (path: string) => invoke<string>("ai_commit_message", { path });
/** Explains one commit from its message and diff (sent to the AI provider). Codes as above, minus "nothing_staged". */
export const aiExplainCommit = (path: string, oid: string) => invoke<string>("ai_explain_commit", { path, oid });
/** Explains a stash: tracked changes plus untracked files (sent to the AI provider). */
export const aiExplainStash = (path: string, oid: string) => invoke<string>("ai_explain_stash", { path, oid });
export const aiWriteRange = (path: string, base: string, head: string, kind: "pr" | "changelog" | "explain") =>
  invoke<string>("ai_write_range", { path, base, head, kind });
/** Proposes a resolution for a conflicted file (sent whole to the AI provider). Writes nothing; apply it with `writeResolved`. */
export const aiResolveConflict = (path: string, file: string) => invoke<string>("ai_resolve_conflict", { path, file });
// Git LFS. Not installed = `installed` false, no patterns.
export const lfs = (path: string) => invoke<Lfs>("lfs", { path });
/** Tracks (or untracks) `pattern`; edits .gitattributes only, left unstaged. */
export const lfsTrack = (path: string, pattern: string, track: boolean) => invoke<void>("lfs_track", { path, pattern, track });
/** `git lfs pull`: downloads LFS content for the checked-out files. */
export const lfsPull = (path: string) => invoke<void>("lfs_pull", { path });

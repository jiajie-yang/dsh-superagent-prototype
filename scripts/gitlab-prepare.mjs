// Run through Execution → Prepare using the dedicated GitLab worker environment.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const env = process.env
const [repo, baseBranch] = process.argv.slice(2)
const directory = env.DSH_SUPERAGENT_DIR
const ticket = env.DSH_SUPERAGENT_TICKET
const name = env.DSH_SUPERAGENT_NAME
const mode = env.DSH_SUPERAGENT_GITLAB_WORKTREE_MODE
const shaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

function run(program, args) {
  try {
    return execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (error) {
    // Keep command output and URLs out of errors. They can include credential-helper diagnostics.
    throw new Error(`${program} ${program === 'git' ? args[2] : args[0]} failed (exit ${error.status ?? error.code ?? 'unknown'})`, { cause: error })
  }
}
const git = (cwd, ...args) => run('git', ['-C', cwd, ...args])
const remoteGit = (...args) => git(repo, '-c', 'http.followRedirects=false', ...args)
function exists(path) {
  try { lstatSync(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
function localRef(ref) {
  try { return git(repo, 'rev-parse', '--verify', '--quiet', ref) } catch (error) { if (error.cause?.status === 1) return ''; throw error }
}

function prepare() {
  if (!repo || !isAbsolute(repo) || !directory || !isAbsolute(directory) || !baseBranch ||
      !/^[a-z0-9][a-z0-9-]*$/.test(ticket ?? '') || !/^[a-z0-9][a-z0-9-]*$/.test(name ?? '')) {
    throw new Error('Expected an absolute clone path, a base branch, and a valid ticket workspace identity')
  }
  const branch = `agent/${name}`
  const branchRef = `refs/heads/${branch}`
  const pin = `refs/dsh-superagent/bases/${ticket}`
  const pinned = localRef(pin)

  if (exists(directory)) {
    // Validate a repeated Prepare locally. A deleted or moved remote branch must not reset a live worktree.
    const common = cwd => realpathSync(git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
    const gitFile = join(directory, '.git')
    if (!pinned || !lstatSync(directory).isDirectory() || !exists(gitFile) || !lstatSync(gitFile).isFile() ||
        common(directory) !== common(repo) ||
        git(directory, 'symbolic-ref', 'HEAD') !== branchRef) {
      throw new Error('Existing workspace is not the pinned worktree for this ticket; inspect it manually')
    }
    git(directory, 'merge-base', '--is-ancestor', pinned, 'HEAD')
    return
  }
  if (mode === 'resume' || pinned || localRef(branchRef)) {
    throw new Error('Ticket workspace is missing but has prior work or a reserved baseline; restore it manually')
  }
  if (mode !== 'base' && mode !== 'mr') throw new Error('Cannot determine the GitLab ticket origin')
  const id = env.DSH_SUPERAGENT_GITLAB_PROJECT_ID
  const instance = new URL(env.DSH_SUPERAGENT_GITLAB_URL)
  if (!/^[1-9]\d*$/.test(id ?? '') || instance.protocol !== 'https:' || instance.href !== instance.origin + '/') {
    throw new Error('Expected the bound HTTPS GitLab instance and numeric project ID')
  }

  const api = path => JSON.parse(run('glab', ['api', '--hostname', instance.host, path, '--method', 'GET']))
  const project = api(`projects/${id}`)
  const clone = new URL(project.http_url_to_repo)
  if (String(project.id) !== id || clone.origin !== instance.origin || clone.username || clone.password ||
      clone.search || clone.hash || !clone.pathname.endsWith('.git') ||
      git(repo, 'remote', 'get-url', '--all', 'origin') !== clone.href ||
      git(repo, 'remote', 'get-url', '--push', '--all', 'origin') !== clone.href) {
    throw new Error('The clone origin must fetch and push to the bound GitLab project over HTTPS')
  }

  let source = baseBranch, target = baseBranch, expected
  if (mode === 'mr') {
    const iid = env.DSH_SUPERAGENT_GITLAB_ORIGIN_MR_IID
    if (!/^[1-9]\d*$/.test(iid ?? '')) throw new Error('Missing or invalid origin MR IID')
    const mr = api(`projects/${id}/merge_requests/${iid}`)
    if (String(mr.iid) !== iid || String(mr.source_project_id) !== id || String(mr.target_project_id) !== id ||
        mr.state !== 'opened' || typeof mr.source_branch !== 'string' || typeof mr.target_branch !== 'string' ||
        typeof mr.sha !== 'string' || !shaPattern.test(mr.sha) || /^0+$/.test(mr.sha) || mr.source_branch === mr.target_branch) {
      throw new Error(`MR !${iid} has no verified open, same-project source and target baseline`)
    }
    source = mr.source_branch
    target = mr.target_branch
    expected = mr.sha
  }
  const sourceRef = `refs/heads/${source}`, targetRef = `refs/heads/${target}`
  git(repo, 'check-ref-format', sourceRef)
  git(repo, 'check-ref-format', targetRef)
  if (branchRef === sourceRef || branchRef === targetRef) throw new Error('Ticket branch collides with a baseline branch')
  // ls-remote prints <sha><TAB><ref>.
  const heads = new Map(remoteGit('ls-remote', '--refs', 'origin', sourceRef, targetRef, branchRef)
    .split('\n').filter(Boolean).map(line => { const [sha, ref] = line.split('\t'); return [ref, sha] }))
  if (heads.has(branchRef)) throw new Error('Ticket branch already exists on origin; inspect it manually')
  if (!heads.has(targetRef) || !heads.has(sourceRef)) throw new Error('GitLab source or target branch is missing on origin')
  expected ??= heads.get(sourceRef)
  if (heads.get(sourceRef) !== expected) throw new Error('MR source branch does not match its API SHA; retry after GitLab converges')

  // Avoid shared FETCH_HEAD, remote-tracking refs and concurrent tickets' staging refs.
  const incoming = `refs/dsh-superagent/incoming/${randomUUID()}`
  try {
    remoteGit('fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--refmap=', 'origin', `${sourceRef}:${incoming}`)
    const fetched = git(repo, 'rev-parse', '--verify', `${incoming}^{commit}`)
    if (fetched !== expected) throw new Error('GitLab source branch changed during fetch; retry Prepare')
    git(repo, 'worktree', 'add', '--no-track', '-b', branch, directory, fetched)
    // Publish the pin only after checkout succeeds. A partial worktree requires operator inspection.
    git(repo, 'update-ref', pin, fetched, '')
    console.log(`Prepared ${branch} from ${sourceRef} at ${fetched}`)
  } finally {
    git(repo, 'update-ref', '-d', incoming)
  }
}

try { prepare() } catch (error) {
  console.error(`GitLab Prepare: ${error.message}`)
  process.exitCode = 1
}

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../scripts/gitlab-prepare.mjs', import.meta.url))
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gitlab-prepare-'))
  roots.push(root)
  const repo = join(root, 'dedicated clone'), remote = join(root, 'remote.git'), bin = join(root, 'bin')
  const work = join(root, 'ticket worktree'), log = join(root, 'calls'), response = join(root, 'mr.json')
  const url = 'https://gitlab.example.test/group/repo.git'
  const gitPath = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_EMAIL: 'fixture@example.test' }
  const git = (cwd: string, ...args: string[]) => execFileSync(gitPath, ['-C', cwd, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git(root, 'init', '--bare', remote)
  git(root, 'init', '-b', 'main', repo)
  git(repo, 'commit', '--allow-empty', '-m', 'base')
  const base = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'switch', '-c', 'human/review')
  git(repo, 'commit', '--allow-empty', '-m', 'MR source')
  const head = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'push', remote, 'main', 'human/review')
  git(repo, 'switch', 'main')
  git(repo, 'remote', 'add', 'origin', url)
  git(repo, 'branch', '-D', 'human/review')
  mkdirSync(bin)
  writeFileSync(join(bin, 'glab'), `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FIXTURE_LOG"
[ "$1 $2 $3" = "api --hostname gitlab.example.test" ]
[ "$5 $6" = "--method GET" ]
case "$4" in
  projects/42) printf '%s\\n' '{"id":42,"http_url_to_repo":"https://gitlab.example.test/group/repo.git"}' ;;
  projects/42/merge_requests/3) cat "$FIXTURE_MR" ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 })
  // Git itself operates on a local bare repository. Rewrite only the two read-only transport calls.
  writeFileSync(join(bin, 'git'), `#!/bin/sh
set -eu
if [ "$3" = "-c" ]; then
  case "$5" in
    ls-remote|fetch) ;;
    *) exit 2 ;;
  esac
  printf '%s\\n' "$5" >> "$FIXTURE_LOG"
  if [ "$5" = fetch ] && [ -n "$FIXTURE_MOVE_HEAD" ]; then
    "$FIXTURE_GIT" -C "$FIXTURE_REMOTE" update-ref refs/heads/human/review "$FIXTURE_MOVE_HEAD"
  fi
  exec "$FIXTURE_GIT" -c "url.file://$FIXTURE_REMOTE.insteadOf=$FIXTURE_URL" "$@"
fi
exec "$FIXTURE_GIT" "$@"
`, { mode: 0o755 })
  const setMr = (patch: Record<string, unknown> = {}) => writeFileSync(response, JSON.stringify({
    iid: 3, state: 'opened', source_project_id: 42, target_project_id: 42, source_branch: 'human/review', target_branch: 'main', sha: head, ...patch,
  }))
  setMr()
  const run = (mode = 'mr', moveHead = '') => spawnSync(process.execPath, [script, repo, 'main'], { encoding: 'utf8', env: { ...env,
    PATH: `${bin}:${process.env.PATH}`, FIXTURE_GIT: gitPath, FIXTURE_REMOTE: remote, FIXTURE_URL: url, FIXTURE_LOG: log, FIXTURE_MR: response, FIXTURE_MOVE_HEAD: moveHead,
    DSH_SUPERAGENT_DIR: work, DSH_SUPERAGENT_TICKET: 'ticket', DSH_SUPERAGENT_NAME: 'task',
    DSH_SUPERAGENT_GITLAB_WORKTREE_MODE: mode, DSH_SUPERAGENT_GITLAB_ORIGIN_MR_IID: '3',
    DSH_SUPERAGENT_GITLAB_PROJECT_ID: '42', DSH_SUPERAGENT_GITLAB_URL: 'https://gitlab.example.test',
  } })
  return { git, run, setMr, root, repo, work, remote, log, base, head, pin: 'refs/dsh-superagent/bases/ticket' }
}

it('prepares an Issue from the configured base without reading an MR', () => {
  const f = fixture()
  expect(f.run('base')).toMatchObject({ status: 0, stderr: '' })
  expect(f.git(f.work, 'rev-parse', 'HEAD')).toBe(f.base)
  expect(readFileSync(f.log, 'utf8')).not.toContain('merge_requests')
})

it('pins the MR source SHA on a separate branch and preserves local work on retry or follow-up', () => {
  const f = fixture()
  expect(f.run()).toMatchObject({ status: 0, stderr: '' })
  expect(f.git(f.work, 'rev-parse', 'HEAD')).toBe(f.head)
  expect(f.git(f.repo, 'rev-parse', f.pin)).toBe(f.head)
  expect(f.git(f.work, 'branch', '--show-current')).toBe('agent/task')
  expect(f.git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/remotes', 'refs/dsh-superagent/incoming')).toBe('')
  expect(f.git(f.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/human/review\nrefs/heads/main')
  f.git(f.work, 'commit', '--allow-empty', '-m', 'local work')
  const local = f.git(f.work, 'rev-parse', 'HEAD')
  const dirty = join(f.work, 'untracked')
  writeFileSync(dirty, 'preserve')
  f.git(f.remote, 'update-ref', 'refs/heads/human/review', f.base)
  const calls = readFileSync(f.log, 'utf8')
  expect(f.run()).toMatchObject({ status: 0, stderr: '' })
  f.git(f.remote, 'update-ref', '-d', 'refs/heads/human/review')
  expect(f.run('resume')).toMatchObject({ status: 0, stderr: '' })
  expect(readFileSync(f.log, 'utf8')).toBe(calls)
  expect(f.git(f.work, 'rev-parse', 'HEAD')).toBe(local)
  expect(readFileSync(dirty, 'utf8')).toBe('preserve')
  rmSync(f.work, { recursive: true })
  expect(f.run('resume')).toMatchObject({ status: 1, stderr: expect.stringContaining('restore it manually') })
  expect(f.run()).toMatchObject({ status: 1, stderr: expect.stringContaining('reserved baseline') })
  expect(existsSync(f.work)).toBe(false)
})

it.each([
  ['foreign source', { source_project_id: 43 }, 'same-project'],
  ['foreign target', { target_project_id: 43 }, 'same-project'],
  ['wrong IID', { iid: 4 }, 'same-project'],
  ['closed MR', { state: 'closed' }, 'same-project'],
  ['missing SHA', { sha: null }, 'same-project'],
  ['malformed source ref', { source_branch: 'bad..name' }, 'check-ref-format'],
  ['missing source ref', { source_branch: 'gone' }, 'branch is missing'],
  ['missing target ref', { target_branch: 'gone' }, 'branch is missing'],
  ['stale API SHA', { sha: 'a'.repeat(40) }, 'does not match its API SHA'],
])('fails closed for %s', (_name, patch, reason) => {
  const f = fixture()
  f.setMr(patch)
  expect(f.run()).toMatchObject({ status: 1, stderr: expect.stringContaining(reason) })
  expect(existsSync(f.work)).toBe(false)
  expect(f.git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/dsh-superagent', 'refs/heads/agent')).toBe('')
})

it('fails when the source changes between advertisement and fetch and can retry with current metadata', () => {
  const f = fixture()
  expect(f.run('mr', f.base)).toMatchObject({ status: 1, stderr: expect.stringContaining('changed during fetch') })
  expect(existsSync(f.work)).toBe(false)
  expect(f.git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/dsh-superagent')).toBe('')
  f.setMr({ sha: f.base })
  expect(f.run()).toMatchObject({ status: 0, stderr: '' })
  expect(f.git(f.work, 'rev-parse', 'HEAD')).toBe(f.base)
})

it('rejects a different push URL, occupied remote ticket branch and unowned existing workspace', () => {
  const f = fixture()
  f.git(f.repo, 'remote', 'set-url', '--push', 'origin', 'https://gitlab.example.test/other/repo.git')
  expect(f.run()).toMatchObject({ status: 1, stderr: expect.stringContaining('bound GitLab project') })
  f.git(f.repo, 'config', '--unset', 'remote.origin.pushurl')
  f.git(f.remote, 'update-ref', 'refs/heads/agent/task', f.base)
  expect(f.run()).toMatchObject({ status: 1, stderr: expect.stringContaining('already exists on origin') })
  mkdirSync(f.work)
  expect(f.run()).toMatchObject({ status: 1, stderr: expect.stringContaining('not the pinned worktree') })
})

it('refuses to recreate a previously used ticket even if its local refs are gone', () => {
  const f = fixture()
  expect(f.run('resume')).toMatchObject({ status: 1, stderr: expect.stringContaining('restore it manually') })
  expect(f.run('unknown')).toMatchObject({ status: 1, stderr: expect.stringContaining('Cannot determine') })
  expect(existsSync(f.log)).toBe(false)
})

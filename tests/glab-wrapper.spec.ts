import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const directories: string[] = []
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))

// Execute the published wrapper itself, so deployment instructions and the tested contract cannot drift.
const documentation = readFileSync(new URL('../docs/006-deployment.md', import.meta.url), 'utf8')
const wrapper = documentation.match(/cat > ~\/\.local\/bin\/glab-gitlab-agent <<'EOF'\n([\s\S]*?)\nEOF/)![1]!
const pinned = ['GITLAB_HOST', 'GITLAB_API_HOST', 'GLAB_API_PROTOCOL', 'GLAB_SKIP_TLS_VERIFY',
  'GLAB_ENABLE_CI_AUTOLOGIN', 'CI', 'GLAB_USE_KEYRING', 'GLAB_IS_OAUTH2', 'GLAB_CONFIG_DIR']
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'glab-wrapper-')); directories.push(directory)
  const token = join(directory, 'agent-token'), cli = join(directory, 'fake-glab'), script = join(directory, 'wrapper'), called = join(directory, 'called')
  writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.writeFileSync(${JSON.stringify(called)}, JSON.stringify(args))
if (process.env.GITLAB_TOKEN === 'expired-fixture') { console.error('401 Unauthorized'); process.exit(1) }
if (args.join(' ') === 'auth git-credential get') {
  console.log('username=agent\\npassword=' + process.env.GITLAB_TOKEN)
} else {
  console.log(JSON.stringify({ args, token: process.env.GITLAB_TOKEN,
    env: Object.fromEntries(${JSON.stringify(pinned)}.map(k => [k, process.env[k]])),
    inherited: ['GITLAB_ACCESS_TOKEN', 'OAUTH_TOKEN', 'CI_JOB_TOKEN', 'GLAB_TOKEN'].filter(k => process.env[k]),
    mode: fs.statSync(${JSON.stringify(token)}).mode & 0o777 }))
}
`, { mode: 0o700 })
  writeFileSync(script, wrapper.replaceAll('$HOME/.config/dsh-superagent/gitlab-agent/glab', directory)
    .replace('/absolute/path/to/glab', cli), { mode: 0o700 })
  writeFileSync(token, 'agent-fixture\n', { mode: 0o600 })
  const run = (...args: string[]) => spawnSync(script, args, { encoding: 'utf8', env: { ...process.env,
    GITLAB_TOKEN: 'personal-fixture', GITLAB_ACCESS_TOKEN: 'personal-fixture', OAUTH_TOKEN: 'personal-fixture',
    CI_JOB_TOKEN: 'personal-fixture', GLAB_TOKEN: 'personal-fixture', GITLAB_CI: 'true',
    GITLAB_HOST: 'foreign.test', GITLAB_API_HOST: 'foreign.test', GLAB_API_PROTOCOL: 'http',
    GLAB_SKIP_TLS_VERIFY: 'true', GLAB_USE_KEYRING: 'true', GLAB_IS_OAUTH2: 'true', GLAB_ENABLE_CI_AUTOLOGIN: 'true', CI: 'false' } })
  return { directory, token, called, run }
}

describe('documented GitLab credential wrapper', () => {
  it('pins the API destination and credential source, overriding ambient credentials for every command', () => {
    const f = fixture()
    for (const args of [['api', '--hostname', 'gitlab.example.com', 'user'], ['mr', 'view', '1'],
      ['api', 'projects/42/merge_requests/1/discussions']]) {
      const result = f.run(...args)
      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toEqual({ args, token: 'agent-fixture', inherited: [], mode: 0o600,
        env: { GITLAB_HOST: 'gitlab.example.com', GITLAB_API_HOST: 'gitlab.example.com', GLAB_API_PROTOCOL: 'https',
          GLAB_SKIP_TLS_VERIFY: 'false', GLAB_ENABLE_CI_AUTOLOGIN: 'false', CI: 'true', GLAB_USE_KEYRING: 'false',
          GLAB_IS_OAUTH2: 'false', GLAB_CONFIG_DIR: join(f.directory, 'config') } })
      expect(readFileSync(f.called, 'utf8')).not.toContain('agent-fixture')
    }
  }, 15_000)

  it.each(['missing', 'empty'] as const)('stops before invoking glab for a %s token file', kind => {
    const f = fixture()
    if (kind === 'missing') rmSync(f.token)
    if (kind === 'empty') writeFileSync(f.token, '')
    const result = f.run('api', 'user')
    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('GitLab agent token file')
    expect(existsSync(f.called)).toBe(false)
  })

  it.skipIf(process.getuid?.() === 0)('stops before invoking glab for an unreadable token file', () => {
    const f = fixture(); chmodSync(f.token, 0)
    try {
      const result = f.run('api', 'user')
      expect(result.status).not.toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('GitLab agent token file')
      expect(existsSync(f.called)).toBe(false)
    } finally { chmodSync(f.token, 0o600) }
  })

  it('uses the same file for Git, reloads atomic rotation and keeps other instances independent', () => {
    const a = fixture(), b = fixture()
    writeFileSync(b.token, 'other-agent-fixture\n')
    expect(a.run('auth', 'git-credential', 'get').stdout).toBe('username=agent\npassword=agent-fixture\n')
    const replacement = join(a.directory, 'replacement')
    writeFileSync(replacement, 'rotated-fixture\n', { mode: 0o600 }); renameSync(replacement, a.token)
    expect(a.run('auth', 'git-credential', 'get').stdout).toContain('password=rotated-fixture')
    expect(JSON.parse(b.run('api', 'user').stdout).token).toBe('other-agent-fixture')
    rmSync(a.token)
    expect(a.run('api', 'user').status).not.toBe(0)
    expect(b.run('auth', 'git-credential', 'get').stdout).toContain('password=other-agent-fixture')
    expect(statSync(b.token).mode & 0o777).toBe(0o600)
  }, 15_000)

  it('propagates authentication failure without retrying with personal credentials or exposing the token', () => {
    const f = fixture(); writeFileSync(f.token, 'expired-fixture\n')
    const result = f.run('api', 'user')
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('401 Unauthorized\n')
    expect(readFileSync(f.token, 'utf8')).toBe('expired-fixture\n')
  })
})

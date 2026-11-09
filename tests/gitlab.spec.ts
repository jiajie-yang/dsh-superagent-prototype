import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, chmodSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { Engine, type Ticket, type Trigger } from '../src/core/index.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { Commands, CliError } from '../src/infra/commands.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { sourceContextOf } from '../src/app/source-context.ts'
import { boundGitlabKind, GitlabConfigSchema, gitlabKind, gitlabTrigger, observeBody, pollGitlab } from '../src/sources/gitlab.ts'
import { claimMerge, gitlabThread, mergeEndNotices, mergeOf, observeMerge } from '../src/sources/gitlab-merge.ts'
import { gitlabPages, gitlabThreadContext, readGitlab, readGitlabRepositoryPath, ObjectSchema, resourcePath, type GitlabObject } from '../src/sources/gitlab-read.ts'
import { sendGitlab } from '../src/sources/gitlab-channel.ts'
import { testDeployment, testMachine } from './fixtures/deployment.ts'
import { deferred } from './fixtures/async.ts'
import { KV } from '../src/kv.ts'
import { githubKind } from '../src/sources/github.ts'
import { Prompts } from '../src/app/prompts.ts'
import { gitlabUrl, resolveGitlab } from '../src/gitlab-deployment.ts'
import { Setup } from '../src/app/setup.ts'
import { ticketCard } from '../src/app/cards.ts'
import { writeEnvironment, workerGitConfig } from '../src/infra/environment.ts'

const dirs: string[] = [], stores: Store[] = []
afterEach(() => { vi.restoreAllMocks(); stores.splice(0).forEach(s => s.close()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
const directory = () => { const d = mkdtempSync(join(tmpdir(), 'gitlab-source-')); dirs.push(d); return d }
const account = { baseUrl: 'https://gitlab.example.com', host: 'gitlab.example.com', projectId: 42, project: 'group/subgroup/repo', cli: '/bin/false', userId: 7, username: 'agent', email: 'agent@example.com' }
const at = '2026-11-03T01:00:00.000Z'
const object = (patch: Partial<GitlabObject> = {}): GitlabObject => ({ id: 100, iid: 3, title: '@agent fix', description: 'A',
  author: { id: 9, username: 'alice' }, created_at: at, updated_at: at, web_url: `${account.baseUrl}/${account.project}/-/issues/3`, state: 'opened', ...patch })
function harness(path = directory()) {
  const store = new Store(join(path, 'db.sqlite')); stores.push(store)
  store.saveSettings(SettingsSchema.parse({ sources: { gitlab: { config: { baseUrl: account.baseUrl, project: account.project, cli: account.cli } } },
    policy: { sources: { gitlab: { allowed: [{ id: `${encodeURIComponent(account.baseUrl)}:9` }] } } } }))
  const sources = new SourceRegistry(() => store.settings(), undefined, undefined, () => 'gitlab'); sources.register(boundGitlabKind(() => account)); sources.register(githubKind)
  const deployment = testDeployment({ repositoryProvider: 'gitlab', gitlab: account, repository: account.project })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const executor = { start: vi.fn(), stop: vi.fn(), deliver: vi.fn() }
  const outbox = { send: vi.fn(), status: () => undefined, withdraw: vi.fn() }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor: { request: vi.fn() }, executor, outbox })
  const receive = vi.fn((trigger: Trigger) => engine.receive(trigger))
  const ctx = sourceContextOf({ store, engine, sources, deployment, commands, outbox, configured: () => true, ready: Promise.resolve(), receive }, gitlabKind)
  return { store, sources, deployment, commands, engine, executor, ctx, receive }
}
function ticket(id: string): Ticket {
  return { id, title: id, decisionId: '', mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'gitlab', id: 'alice' }, scope: '' },
    channels: [], assignments: [], inputs: [], undelivered: [], createdAt: at, updatedAt: at, origin: { triggerId: `source-${id}`, triggerIds: [] },
    execution: { name: id, directory: '/tmp/work', assignment: '' } }
}
const mr = (patch: Partial<GitlabObject> = {}) => object({ web_url: `${account.baseUrl}/${account.project}/-/merge_requests/3`, source_project_id: 42, target_project_id: 42, author: { id: 7, username: 'agent' }, source_branch: 'agent/task', ...patch })

describe('GitLab events and policy', () => {
  it('isolates instances, projects and issue/MR IDs; ignores the agent and evaluates allowed mentions', () => {
    const h = harness(), obj = object()
    const event = gitlabTrigger(h.ctx, 'issue', obj, { id: 'new', text: '@agent fix it', at, userId: 9, username: 'alice' })!
    expect(event).toMatchObject({ human: true, addressed: 'mention' })
    expect(gitlabTrigger(h.ctx, 'issue', obj, { id: 'self', text: '@agent', at, userId: 7, username: 'agent' })).toBeUndefined()
    expect(new Set([gitlabThread(account.baseUrl, 42, 'issue', 3), gitlabThread(account.baseUrl, 42, 'mr', 3), gitlabThread(account.baseUrl, 43, 'issue', 3), gitlabThread('https://other.test', 42, 'issue', 3)]).size).toBe(4)
    h.engine.receive(event); h.engine.evaluateDue()
    expect(h.engine.candidate(event.id)?.strength).toBe('explicit')
    expect(h.sources.instance('github')?.enabled).toBe(false)
    expect(h.sources.environments().map(e => e.kind.kind)).toEqual(['gitlab'])
    expect(h.sources.scope({ source: 'gitlab', meta: { ...event.meta, projectId: 43 } }).listened).toBe(false)
  })
  it('persists A-B-A as distinct observations, ignores stale/unchanged updates, and never authorizes edits as the original author', () => {
    const h = harness()
    observeBody(h.ctx, 'issue', object(), at)
    observeBody(h.ctx, 'issue', object({ description: 'B', updated_at: '2026-11-03T01:01:00Z' }), at)
    observeBody(h.ctx, 'issue', object({ updated_at: '2026-11-03T01:02:00Z' }), at)
    expect(new Set(h.receive.mock.calls.map(c => c[0].id)).size).toBe(3)
    expect(h.receive.mock.calls[1]![0]).toMatchObject({ human: false, at: '2026-11-03T01:01:00Z' })
    observeBody(h.ctx, 'issue', object({ updated_at: '2026-11-03T01:03:00Z' }), at)
    observeBody(h.ctx, 'issue', object({ description: 'old', updated_at: '2026-11-03T00:59:00Z' }), at)
    expect(h.receive).toHaveBeenCalledTimes(3)
  })
  it('rolls back both the body observation and trigger if a synchronous receiver fails after intake', () => {
    const h = harness()
    h.receive.mockImplementationOnce(t => { h.engine.receive(t); throw new Error('crash') })
    expect(() => observeBody(h.ctx, 'issue', object(), at)).toThrow('crash')
    expect(h.store.read.recentTriggers(0, 10)).toHaveLength(0)
    expect(h.store.get(KV.gitlab.body(gitlabThread(account.baseUrl, 42, 'issue', 3)))).toBeUndefined()
    observeBody(h.ctx, 'issue', object(), at)
    expect(h.store.read.recentTriggers(0, 10)).toHaveLength(1)
  })
  it('fans CI into a subscribed live ticket without allowing new work or resuming an ended ticket', () => {
    const h = harness(), t = ticket('task'), id = gitlabThread(account.baseUrl, 42, 'mr', 3)
    h.store.tickets.save(t); h.engine.bindThread(t.id, { source: 'gitlab', id }, true)
    const ci: Trigger = { id: 'ci', source: 'gitlab', threads: [{ source: 'gitlab', id }], actor: { source: 'gitlab', id: '' }, human: false,
      text: 'failed', at, meta: { instance: account.baseUrl, project: account.project, projectId: 42, ci: true } }
    expect(h.sources.scope(ci)).toMatchObject({ listened: true, observed: false })
    h.engine.receive(ci); h.engine.evaluateDue()
    expect(h.store.tickets.get(t.id)?.inputs.some(i => i.kind === 'trigger' && i.triggerId === 'ci')).toBe(true)
    expect(h.engine.candidate(ci.id)).toBeUndefined()
    const ended = { ...h.store.tickets.get(t.id)!, ended: { at, by: 'executor' as const, outcome: 'merged' as const } }
    h.store.tickets.save(ended); h.engine.receive({ ...ci, id: 'ci2' })
    expect(h.store.tickets.get(t.id)?.ended).toBeDefined()
  })
})

describe('GitLab MR and replies', () => {
  it('binds only the agent ticket branch, rejects forks/another owner and projects the MR in cards', () => {
    const h = harness(); h.store.tickets.save(ticket('task')); h.store.tickets.save(ticket('other'))
    expect(claimMerge(h.ctx, 'task', mr({ source_project_id: 99 }))).toMatch(/Fork/)
    expect(claimMerge(h.ctx, 'task', mr({ source_branch: 'wrong' }))).toMatch(/not/)
    expect(claimMerge(h.ctx, 'task', mr())).toBeUndefined()
    expect(claimMerge(h.ctx, 'other', mr({ source_branch: 'other' }))).toMatch(/another/)
    expect(ticketCard(h.store.tickets.get('task')!, key => h.store.threads.get(key))).toMatchObject({ mr_iid: 3, mr_url: expect.stringContaining('merge_requests/3') })
    expect(mergeOf(h.store.tickets.get('task')!)?.iid).toBe(3)
    const bind = vi.spyOn(h.ctx.tickets, 'bindThread')
    observeMerge(h.ctx, mr())
    expect(bind).not.toHaveBeenCalled()
    observeMerge(h.ctx, mr({ state: 'merged', merged_at: at }))
    expect(h.store.tickets.get('task')?.follows?.[0]?.closed?.outcome).toBe('merged')
  })
  it('replies to the original discussion and finds a committed marker on retry; foreign users cannot spoof the marker', async () => {
    const h = harness(), api = vi.spyOn(h.commands, 'gitlab')
    const channel = { source: 'gitlab', thread: 'gitlab:x', address: { instance: account.baseUrl, projectId: '42', objectKind: 'mr', iid: '3', discussionId: 'd1' } }
    const message = { id: 'out', channel, text: 'result', kind: 'reply' as const }
    const signed = 'This is by an automated agent, not a human.\n\nresult'
    api.mockResolvedValueOnce([]).mockResolvedValueOnce({})
    expect(await sendGitlab(h.ctx, message)).toBe('sent')
    expect(api.mock.calls[1]).toEqual(['merge_requests/3/discussions/d1/notes', 'POST', { body: `${signed}\n\n<!-- dsh-superagent:out -->` }])
    api.mockResolvedValueOnce([{ id: 1, body: '<!-- dsh-superagent:out -->', author: { id: 7, username: 'agent' }, created_at: at, updated_at: at }])
    expect(await sendGitlab(h.ctx, message)).toBe('sent')
    expect(api).toHaveBeenCalledTimes(3)
    api.mockResolvedValueOnce([]).mockResolvedValueOnce({})
    expect(await sendGitlab(h.ctx, { ...message, id: 'signed', text: signed })).toBe('sent')
    expect(api.mock.calls[4]![2]).toEqual({ body: `${signed}\n\n<!-- dsh-superagent:signed -->` })
    api.mockRejectedValueOnce(new CliError('not found', 404))
    await expect(sendGitlab(h.ctx, message)).rejects.toThrow('not found')
    await expect(sendGitlab(h.ctx, { ...message, channel: { ...channel, address: { ...channel.address, projectId: '43' } } })).rejects.toThrow('outside')
  })
  it('does not move the poll cursor on API failure and scans discussions even without a changed parent', async () => {
    const h = harness(), api = vi.spyOn(h.commands, 'gitlab')
    h.store.set(KV.gitlab.since, at)
    api.mockRejectedValueOnce(new Error('offline'))
    await expect(pollGitlab(h.ctx)).rejects.toThrow('offline')
    expect(h.store.get(KV.gitlab.since)).toBe(at)
    api.mockImplementation(async path => {
      if (path.startsWith('issues?')) return [object()] as never
      if (path.startsWith('merge_requests?')) return [] as never
      if (path.startsWith('issues/3/discussions')) return [{ id: 'd1', notes: [{ id: 5, body: '@agent later request', author: { id: 9, username: 'alice' }, created_at: at, updated_at: at }] }] as never
      throw new Error(path)
    })
    await pollGitlab(h.ctx)
    expect(h.receive.mock.calls.some(c => c[0].meta.noteId === 5)).toBe(true)
    const count = h.store.read.recentTriggers(0, 100).length
    h.store.set(KV.gitlab.since, at); await pollGitlab(h.ctx)
    expect(h.store.read.recentTriggers(0, 100)).toHaveLength(count)
  })
  it('uses explicit pagination and refuses unsafe resources', async () => {
    const h = harness(), api = vi.spyOn(h.commands, 'gitlab')
    api.mockResolvedValueOnce(Array.from({ length: 100 }, () => object())).mockResolvedValueOnce([])
    expect(await gitlabPages(h.commands, ObjectSchema, 'issues')).toHaveLength(100)
    expect(api.mock.calls[1]![0]).toBe('issues?per_page=100&page=2')
    expect(() => resourcePath('gitlab/mr/3/../../user')).toThrow()
    expect(() => resourcePath('gitlab/issue/3/diffs')).toThrow()
  })
})

describe('GitLab deployment and prompt contracts', () => {
  it('rejects unsafe instance URLs and verifies a dedicated CLI, account, project and permission', async () => {
    for (const value of ['http://gitlab.example.com', 'https://user:secret@gitlab.example.com', 'https://gitlab.example.com/path']) expect(() => gitlabUrl(value)).toThrow()
    const d = directory(), cli = join(d, 'glab-agent'); writeFileSync(cli, '#!/bin/sh\nexit 1\n'); chmodSync(cli, 0o755)
    const probe = vi.fn().mockResolvedValueOnce(JSON.stringify({ id: 7, username: 'agent', email: 'agent@example.com' })).mockResolvedValueOnce(JSON.stringify({ id: 42, path_with_namespace: account.project, http_url_to_repo: `${account.baseUrl}/${account.project}.git`, permissions: { project_access: { access_level: 30 }, group_access: null } }))
    const resolved = await resolveGitlab(testMachine({ stateDir: d }), { baseUrl: account.baseUrl, project: account.project, cli }, probe)
    expect(resolved.gitlab).toMatchObject({ projectId: 42, userId: 7 })
    expect(probe.mock.calls[0]![0]).toEqual([cli, 'api', '--hostname', account.host, 'user'])
    await writeEnvironment(resolved, ['glab'])
    expect(readFileSync(workerGitConfig(resolved.stateDir), 'utf8')).toContain(`[credential "${account.baseUrl}"]`)
    expect(readFileSync(join(resolved.stateDir, 'worker-bin', 'glab'), 'utf8')).toContain(`exec '${cli}'`)
  })
  it('rejects binding changes even with only ended tickets and preserves custom prompt text', () => {
    const h = harness()
    h.store.set(KV.store.binding, { provider: 'gitlab', instance: account.baseUrl, projectId: '42', agentId: '7' })
    const setup = new Setup({ store: h.store, context: {} as never, machine: testMachine(), lifetime: new AbortController().signal, restart: vi.fn() })
    // Exercise binding independently from subprocess probes.
    const bind = setup as unknown as { bind(value: typeof h.deployment, write: boolean): void }
    expect(() => bind.bind({ ...h.deployment, gitlab: { ...account, projectId: 43 } }, false)).toThrow('new state directory')
    expect(() => bind.bind({ ...h.deployment, gitlab: undefined }, false)).toThrow('new state directory')
    const prompts = new Prompts(h.store, () => 100000, () => [], () => false, () => 'gitlab')
    const config = prompts.current().config
    expect(prompts.compose(config, 'worker')).not.toContain('DSH_SUPERAGENT_GITHUB_ACCOUNT')
    expect(prompts.skills(config).map(([name]) => name)).toEqual(['gitlab'])
    expect(() => prompts.validate({ ...config, skills: { gitlab: 'Custom collision' } })).toThrow('built-in skill')
    const reset = prompts.validate({ ...config, overrides: {} })
    expect(prompts.compose(reset, 'worker')).not.toContain('DSH_SUPERAGENT_GITHUB_ACCOUNT')
    expect(prompts.preview(reset).worker).toContain('Use glab')
    expect(prompts.defaultChanged(reset)).toEqual([])
    prompts.save({ ...config, delivery: 'Custom delivery instruction' }, 0, 'panel')
    expect(prompts.current().config.delivery).toBe('Custom delivery instruction')
  })
})

it('refuses to reuse unbound repository history for a new GitLab deployment', () => {
  const h = harness()
  h.store.tickets.save(ticket('old-task'))
  const setup = new Setup({ store: h.store, context: {} as never, machine: testMachine(), lifetime: new AbortController().signal, restart: vi.fn() })
  const bind = setup as unknown as { bind(value: typeof h.deployment, write: boolean): void }
  expect(() => bind.bind(h.deployment, false)).toThrow('new state directory')
  expect(h.store.get(KV.store.binding)).toBeUndefined()
})

it('boots GitLab-only with GitHub installed and routes a Feishu task through worker report, MR follow-up and merge notification', async () => {
  const { startRuntime, feishu } = await import('./fixtures/host.ts')
  const h = await startRuntime(undefined, 'gitlab')
  try {
    expect(h.runtime.configured()).toBe(true)
    expect(h.runtime.deployment.github).toBeUndefined()
    expect(h.runtime.sources.instance('github')?.enabled).toBe(false)
    expect(h.runtime.store.get(KV.store.binding)).toMatchObject({ provider: 'gitlab', projectId: '42' })
    const { settings, store } = h.runtime
    await expect(settings.save('executor', { ...store.settings().executor, blockedCommands: ['glab'] },
      store.blockRevision('executor'), 'panel')).rejects.toThrow('glab cannot be blocked')
    const { ticket: t } = await h.acceptedTicket(feishu('1', '修复按钮'))
    const current = h.runtime.store.tickets.get(t.id)!
    const merge = mr({ source_branch: `agent/${current.execution!.name}`, author: { id: 7, username: 'agent-bot' } })
    vi.spyOn(Commands.prototype, 'gitlab').mockResolvedValue(merge)
    // The worker session id is shared with executor routing rather than constructed by this test.
    const { workerSessionId } = await import('../src/executor/dsh.ts')
    const session = workerSessionId(t.id)
    await expect(h.runTool(session, 'orchestrator_report', { state: 'ready', summary: '已验证并提交 MR', mr_iid: 3 })).resolves.toMatchObject({ reported: true })
    expect(h.runtime.store.tickets.get(t.id)?.ended).toBeUndefined()
    expect(ticketCard(h.runtime.store.tickets.get(t.id)!)).toMatchObject({ mr_iid: 3 })
    await expect(h.runTool(session, 'orchestrator_report', { state: 'ready', summary: 'bad', pr_number: 3 })).rejects.toThrow('only for GitHub')
    await expect(h.runTool(session, 'orchestrator_read', { resource: 'gitlab/mr/4' })).rejects.toThrow('does not belong')
    const followup = gitlabTrigger(h.runtime.context(gitlabKind), 'mr', merge, { id: 'review-note', text: '请补上验证', at: new Date().toISOString(), userId: 9, username: 'alice', noteId: 99, discussionId: 'd99' })!
    h.runtime.receive(followup); await h.runtime.idle()
    expect(h.runtime.store.tickets.get(t.id)?.inputs.some(i => i.kind === 'trigger' && i.triggerId === followup.id)).toBe(true)
    await h.runTool(session, 'orchestrator_report', { state: 'ready', summary: '已补齐验证', mr_iid: 3 })
    observeMerge(h.runtime.context(gitlabKind), { ...merge, state: 'merged', merged_at: new Date(Date.now() + 1000).toISOString() })
    await h.runtime.idle()
    expect(h.runtime.store.tickets.get(t.id)?.ended?.outcome).toBe('merged')
    expect(h.runtime.store.db.prepare("SELECT value FROM outbox WHERE value LIKE '%MR !3%'").all().length).toBeGreaterThan(0)
    const original = h.runtime.store.settings().sources.gitlab!
    const cli = String(original.config.cli)
    h.answers[`${cli} api --hostname gitlab.example.com user`] = JSON.stringify({ id: 7, username: 'agent-bot', email: 'bot@example.com' })
    h.answers[`${cli} api --hostname gitlab.example.com projects/acme%2Fother`] = JSON.stringify({ id: 43, path_with_namespace: 'acme/other', http_url_to_repo: 'https://gitlab.example.com/acme/other.git', permissions: { project_access: { access_level: 30 }, group_access: null } })
    await expect(h.runtime.settings.save('source:gitlab', { ...original, config: { ...original.config, project: 'acme/other' } }, h.runtime.store.blockRevision('source:gitlab'), 'panel')).rejects.toThrow('new state directory')
    expect(h.runtime.store.settings().sources.gitlab?.config.project).toBe('acme/widgets')
  } finally { await h.stop() }
})

it('retains body revision through closing and reopening SQLite without replaying the same observation', () => {
  const path = directory(), first = harness(path)
  observeBody(first.ctx, 'issue', object(), at)
  first.store.close(); stores.splice(stores.indexOf(first.store), 1)
  const restored = harness(path)
  observeBody(restored.ctx, 'issue', object(), at)
  expect(restored.receive).not.toHaveBeenCalled()
  observeBody(restored.ctx, 'issue', object({ description: 'B', updated_at: '2026-11-03T01:01:00Z' }), at)
  observeBody(restored.ctx, 'issue', object({ updated_at: '2026-11-03T01:02:00Z' }), at)
  expect(restored.store.read.recentTriggers(0, 100)).toHaveLength(3)
})

it('persists its first baseline before network access so a failed first round cannot advance it on retry', async () => {
  const h = harness()
  vi.spyOn(h.commands, 'gitlab').mockRejectedValue(new Error('offline'))
  await expect(pollGitlab(h.ctx)).rejects.toThrow('offline')
  const baseline = h.store.get(KV.gitlab.since)
  expect(baseline).toBeDefined()
  await expect(pollGitlab(h.ctx)).rejects.toThrow('offline')
  expect(h.store.get(KV.gitlab.since)).toBe(baseline)
})


it('treats explicitly listed automated accounts as bots even when note author payload omits bot metadata', () => {
  const h = harness(), settings = h.store.settings(), id = `${encodeURIComponent(account.baseUrl)}:9`
  h.store.saveSettings({ ...settings, policy: { ...settings.policy, sources: { gitlab: { allowed: [], bots: [{ id }] } } } })
  const event = gitlabTrigger(h.ctx, 'issue', object(), { id: 'bot', text: '@agent check', at, userId: 9, username: 'reviewer' })!
  expect(event.human).toBe(false)
  h.engine.receive(event); h.engine.evaluateDue()
  expect(h.engine.candidate(event.id)?.strength).toBe('inferred')
})

it('uses an object cursor rather than a later scan cursor when an object was skipped in an earlier page set', async () => {
  const h = harness()
  h.store.set(KV.gitlab.baseline, at)
  h.store.set(KV.gitlab.since, '2026-11-03T02:00:00.000Z')
  const thread = gitlabThread(account.baseUrl, 42, 'issue', 3)
  h.store.set(KV.gitlab.cursor(thread), at)
  vi.spyOn(h.commands, 'gitlab').mockImplementation(async path => {
    if (path.startsWith('issues?')) return [object()] as never
    if (path.startsWith('merge_requests?')) return [] as never
    if (path.startsWith('issues/3/discussions')) return [{ id: 'late', notes: [{ id: 101, body: '@agent recover me', author: { id: 9, username: 'alice' }, created_at: '2026-11-03T01:30:00.000Z', updated_at: '2026-11-03T01:30:00.000Z' }] }] as never
    throw new Error(path)
  })
  await pollGitlab(h.ctx)
  expect(h.receive.mock.calls.some(([event]) => event.meta.noteId === 101)).toBe(true)
})


describe('GitLab minimal repair regressions', () => {
  it('resolves empty and invalid stored config when the installed plugin is not selected', () => {
    expect(GitlabConfigSchema.parse({}).baseUrl).toBe('')
    for (const sources of [{}, { gitlab: { config: { baseUrl: 'invalid' } } }]) {
      const registry = new SourceRegistry(() => SettingsSchema.parse({ sources }))
      registry.register(gitlabKind); registry.register(githubKind)
      expect(registry.instances().find(i => i.kind === 'gitlab')).toMatchObject({ enabled: false, config: { baseUrl: '' } })
      expect(registry.policyPart('gitlab')).toBeDefined()
    }
  })

  it('continues after a missing subscription, invalid list item and broken discussions; retries only failed cursors', async () => {
    const h = harness(), bad = gitlabThread(account.baseUrl, 42, 'issue', 1), closed = gitlabThread(account.baseUrl, 42, 'mr', 3)
    h.store.set(KV.gitlab.baseline, at)
    h.store.tickets.save(ticket('task'))
    h.engine.bindThread('task', { source: 'gitlab', id: bad }, false)
    h.engine.bindThread('task', { source: 'gitlab', id: closed }, true)
    h.store.set(KV.gitlab.cursor(bad), at); h.store.set(KV.gitlab.cursor(closed), at)
    let broken = true
    const api = vi.spyOn(h.commands, 'gitlab').mockImplementation(async path => {
      if (path === 'issues/1') throw new CliError('deleted', 404)
      if (path === 'merge_requests/3') return mr({ state: 'closed', closed_at: at }) as never
      if (path.startsWith('merge_requests/3/discussions') && broken) throw new Error('discussion unavailable')
      if (path.startsWith('issues?')) return [{ invalid: true }, object({ iid: 4 })] as never
      if (path.startsWith('merge_requests?')) return [mr()] as never
      if (path.includes('/discussions')) return [] as never
      throw new Error(path)
    })
    await expect(pollGitlab(h.ctx)).resolves.toBeUndefined()
    expect(h.store.get(KV.gitlab.cursor(bad))).toBe(at)
    expect(h.store.get(KV.gitlab.cursor(closed))).toBe(at)
    expect(h.store.get(KV.gitlab.cursor(gitlabThread(account.baseUrl, 42, 'issue', 4)))).not.toBe(at)
    expect(h.store.tickets.get('task')?.follows?.find(f => f.thread === `gitlab:${closed}`)?.closed?.outcome).toBe('closed')
    expect(h.store.threads.get(`gitlab:${bad}`)?.meta.pollError).toContain('deleted')
    expect(h.store.threads.get(`gitlab:${closed}`)?.meta.pollError).toContain('discussion unavailable')
    broken = false
    await pollGitlab(h.ctx)
    expect(h.store.get(KV.gitlab.cursor(closed))).not.toBe(at)
    expect(h.store.threads.get(`gitlab:${closed}`)?.meta.pollError).toBeUndefined()
    expect(api.mock.calls.filter(([path]) => path.startsWith('issues/4/discussions'))).toHaveLength(2)
  })

  it('polls MRs when issue discovery fails and propagates cancellation without closing the MR', async () => {
    const h = harness(), t = ticket('task'), id = gitlabThread(account.baseUrl, 42, 'mr', 3)
    h.store.tickets.save(t); h.engine.bindThread(t.id, { source: 'gitlab', id }, true)
    const stop = new AbortController()
    vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
    let cancel = false
    vi.spyOn(h.commands, 'gitlab').mockImplementation(async path => {
      if (path.startsWith('issues?')) throw new Error('issues unavailable')
      if (path === 'merge_requests/3') return mr({ state: cancel ? 'merged' : 'opened' }) as never
      if (path.startsWith('merge_requests?')) return [] as never
      if (path.includes('/discussions')) { if (cancel) { stop.abort(new Error('cancelled')); throw stop.signal.reason }; return [] as never }
      throw new Error(path)
    })
    await pollGitlab(h.ctx)
    expect(h.store.get(KV.gitlab.cursor(id))).toBeDefined()
    cancel = true
    await expect(pollGitlab(h.ctx, stop.signal)).rejects.toThrow('cancelled')
    expect(h.store.tickets.get(t.id)?.follows?.[0]?.closed).toBeUndefined()
  })

  it.each([['head', 'head'], ['head', 'synthetic-merge']])('observes pipeline changes for MR head %s and pipeline SHA %s as context only', async (head, sha) => {
    const h = harness(), id = gitlabThread(account.baseUrl, 42, 'mr', 3)
    h.store.tickets.save(ticket('task')); h.engine.bindThread('task', { source: 'gitlab', id }, true)
    let status = 'running', currentHead = head
    vi.spyOn(h.commands, 'gitlab').mockImplementation(async path => {
      if (path === 'merge_requests/3') return mr({ sha: currentHead, head_pipeline: { id: 10, sha, status } }) as never
      if (path.includes('?state=all') || path.includes('/discussions')) return [] as never
      throw new Error(path)
    })
    await pollGitlab(h.ctx)
    expect(h.receive.mock.calls.filter(([e]) => e.meta.ci)).toHaveLength(0)
    status = 'failed'; await pollGitlab(h.ctx)
    const event = h.receive.mock.calls.map(([e]) => e).find(e => e.meta.ci)!
    expect(event).toMatchObject({ human: false, meta: { headSha: head, pipelineSha: sha, pipelineStatus: 'failed', headAssociation: head === sha ? 'matching_sha' : 'unverified' } })
    expect(h.store.tickets.get('task')?.inputs.some(i => i.kind === 'trigger' && i.triggerId === event.id)).toBe(true)
    h.engine.evaluateDue(); expect(h.engine.candidate(event.id)).toBeUndefined()
    status = 'success'; await pollGitlab(h.ctx)
    currentHead = 'new-head'; await pollGitlab(h.ctx)
    const last = h.receive.mock.calls.map(([e]) => e).filter(e => e.meta.ci).at(-1)!
    expect(last).toMatchObject({ meta: { headSha: 'new-head', pipelineSha: sha, headAssociation: 'unverified' } })
    expect(last.text).toContain('unverified')
    const count = h.receive.mock.calls.length
    await pollGitlab(h.ctx); expect(h.receive.mock.calls.length).toBe(count)
  })

  it('auto-binds an MR before its first review and persists pipeline feedback across SQLite restarts', async () => {
    const path = directory(), id = gitlabThread(account.baseUrl, 42, 'mr', 3)
    let h = harness(path), pipeline: GitlabObject['head_pipeline'] = null
    const mock = () => vi.spyOn(h.commands, 'gitlab').mockImplementation(async path => {
      if (path === 'merge_requests/3') return mr({ sha: 'head', head_pipeline: pipeline }) as never
      if (path.startsWith('merge_requests?')) return [mr()] as never
      if (path.includes('/discussions')) return [{ id: 'first-review', notes: [{ id: 99, body: 'Please add a regression test', author: { id: 9, username: 'alice' }, created_at: at, updated_at: at }] }] as never
      if (path.includes('?state=all')) return [] as never
      throw new Error(path)
    })
    const reopen = () => {
      h.store.close(); stores.splice(stores.indexOf(h.store), 1)
      h = harness(path); mock()
    }
    mock()
    h.store.tickets.save(ticket('task')); h.store.set(KV.gitlab.baseline, at)
    await pollGitlab(h.ctx)
    expect(h.store.tickets.get('task')?.follows).toContainEqual({ thread: `gitlab:${id}`, own: true })
    const review = h.receive.mock.calls.map(([e]) => e).find(e => e.meta.noteId === 99)!
    expect(review.meta.projectScan).toBe(false)
    expect(h.store.triggers.disposition(review.id)?.filtered).toBeUndefined()
    expect(h.store.tickets.get('task')?.inputs.filter(i => i.kind === 'trigger' && i.triggerId === review.id)).toHaveLength(1)
    expect(h.receive.mock.calls.filter(([e]) => e.meta.ci)).toHaveLength(0)
    expect(h.store.get(KV.gitlab.ci(id))).toEqual({ fingerprint: 'no-pipeline', revision: 0 })
    reopen()
    pipeline = { id: 10, sha: 'head', status: 'failed' }
    await pollGitlab(h.ctx)
    const events = h.receive.mock.calls.map(([e]) => e).filter(e => e.meta.ci)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ human: false, meta: { pipelineId: 10, pipelineStatus: 'failed' } })
    await pollGitlab(h.ctx)
    expect(h.receive.mock.calls.filter(([e]) => e.meta.ci)).toHaveLength(1)
    const observed = h.store.get(KV.gitlab.ci(id))
    pipeline = null; await pollGitlab(h.ctx)
    expect(h.store.get(KV.gitlab.ci(id))).toEqual(observed)
    reopen()
    pipeline = { id: 10, sha: 'head', status: 'failed' }
    await pollGitlab(h.ctx)
    expect(h.receive.mock.calls.filter(([e]) => e.meta.ci)).toHaveLength(0)
    expect(h.store.tickets.get('task')?.inputs.filter(i => i.kind === 'trigger' && i.triggerId === events[0]!.id)).toHaveLength(1)
    expect(h.store.tickets.get('task')?.inputs.filter(i => i.kind === 'trigger' && i.triggerId === review.id)).toHaveLength(1)
  })

  it('revalidates old path mandates and resumes ended work after a same-ID project rename, but rejects foreign identities', () => {
    const h = harness(), event = gitlabTrigger(h.ctx, 'issue', object(), { id: 'original', text: '@agent fix', at, userId: 9, username: 'alice' })!
    const t = ticket('task')
    t.mandate = { ...t.mandate, actor: event.actor, basis: { via: 'addressed', source: 'gitlab', scope: event.meta, addressed: 'mention' } }
    h.store.tickets.save(t); h.engine.bindThread(t.id, event.threads[0]!, false)
    h.store.tickets.save({ ...h.store.tickets.get(t.id)!, ended: { at, by: 'executor', outcome: 'completed' } })
    const settings = h.store.settings(), original = settings.sources.gitlab!
    h.store.saveSettings({ ...settings, sources: { ...settings.sources, gitlab: { ...original, config: { ...original.config, project: 'renamed/repo' } } } })
    const policy = settingsPolicy(h.store.settings(), h.sources)
    expect(policy.revalidate(t.mandate)).toBe(true)
    for (const patch of [{ projectId: 43 }, { instance: 'https://foreign.test' }]) {
      expect(policy.revalidate({ ...t.mandate, basis: { ...t.mandate.basis, scope: { ...event.meta, ...patch } } })).toBe(false)
    }
    h.engine.receive({ ...event, id: 'after-rename', at: new Date().toISOString(), meta: { ...event.meta, project: 'renamed/repo' } })
    expect(h.store.tickets.get(t.id)?.ended).toBeUndefined()
  })

  it('keeps new/deleted diff positions in normalized and raw discussion reads without inventing missing lines', async () => {
    const h = harness(), trigger = gitlabTrigger(h.ctx, 'mr', mr({ author: { id: 9, username: 'alice' } }), { id: 'review', text: 'review', at, userId: 9, username: 'alice' })!
    const positions = [{ new_path: 'new.ts', new_line: 12, old_path: 'old.ts', old_line: null, base_sha: 'base', start_sha: 'start', head_sha: 'head', position_type: 'text' },
      { new_path: 'new.ts', new_line: null, old_path: 'old.ts', old_line: 8 }, null, { new_path: 'new.ts', new_line: null, old_line: null }]
    const discussions = [{ id: 'd1', notes: positions.map((position, id) => ({ id: id + 1, body: 'review', author: { id: 9, username: 'alice' }, created_at: at, updated_at: at, type: position ? 'DiffNote' : null, position })) }]
    vi.spyOn(h.commands, 'gitlab').mockImplementation(async path => (path.includes('/discussions') ? discussions : mr()) as never)
    const context = await gitlabThreadContext.read(h.commands, trigger, 'thread', undefined, {})
    expect(context.messages.slice(1, 3)).toMatchObject([{ path: 'new.ts', line: 12 }, { path: 'old.ts', line: 8 }])
    expect(context.messages.slice(3).every(m => !('line' in m))).toBe(true)
    expect(await readGitlab(h.commands, 'gitlab/mr/3/discussions')).toMatchObject(discussions)
  })

  it('notifies the latest closed own MR with its own outcome, independently of binding order', () => {
    const h = harness(), t = ticket('task'), thread = (iid: number) => `gitlab:${gitlabThread(account.baseUrl, 42, 'mr', iid)}`
    t.channels = [{ source: 'feishu', thread: 'feishu:test', address: {} }]
    t.ended = { at, by: 'executor', outcome: 'closed' }
    t.follows = [
      { thread: thread(1), own: true, closed: { at: '2026-11-03T03:00:00Z', outcome: 'closed' } },
      { thread: thread(2), own: true, closed: { at: '2026-11-03T02:00:00Z', outcome: 'merged' } },
      { thread: thread(3), own: false, closed: { at: '2026-11-03T04:00:00Z', outcome: 'merged' } },
    ]
    const notices = mergeEndNotices(t, '请修复', h.ctx)
    expect(notices[0]?.text).toContain('MR !1'); expect(notices[0]?.text).toContain('已关闭，未合并')
    t.follows.reverse(); expect(mergeEndNotices(t, '请修复', h.ctx)).toEqual(notices)
    t.follows = t.follows.filter(f => !f.own)
    expect(mergeEndNotices(t, 'fix', h.ctx)[0]?.text).toContain('MR !3')
    expect(mergeEndNotices(t, 'fix', h.ctx)[0]?.text).toContain('merged.')
  })
})


it('keeps GitHub runtime settings readable with an installed, unconfigured GitLab plugin', async () => {
  const { startRuntime } = await import('./fixtures/host.ts')
  const h = await startRuntime()
  try {
    h.runtime.sources.register(boundGitlabKind(() => h.runtime.deployment.gitlab))
    expect(h.runtime.configured()).toBe(true)
    const settings = await h.api('GET', 'settings')
    expect(settings.status).toBe(200)
    expect(settings.body).toMatchObject({ sources: expect.arrayContaining([expect.objectContaining({ id: 'gitlab', value: { enabled: false, config: expect.objectContaining({ baseUrl: '' }) } })]) })
  } finally { await h.stop() }
})


describe('GitLab stop and repository path regressions', () => {
  it.each(['waiting for discussions', 'after the first note'] as const)('retains unread notes when Source is disabled %s', async stage => {
    const h = harness(), id = gitlabThread(account.baseUrl, 42, 'mr', 3)
    const original = h.store.settings()
    const enable = (enabled: boolean) => h.store.saveSettings({ ...original, sources: { ...original.sources, gitlab: { ...original.sources.gitlab!, enabled } } })
    h.store.tickets.save(ticket('task')); h.engine.bindThread('task', { source: 'gitlab', id }, true)
    h.store.set(KV.gitlab.since, at); h.store.set(KV.gitlab.cursor(id), at)
    const requested = deferred(), response = deferred<unknown>()
    const discussions = [{ id: 'd1', notes: [1, 2].map(noteId => ({ id: noteId, body: '@agent review', author: { id: 9, username: 'alice' }, created_at: at, updated_at: at })) }]
    let firstRequest = true
    vi.spyOn(h.commands, 'gitlab').mockImplementation(async path => {
      if (path === 'merge_requests/3') return mr({ state: 'closed', closed_at: at }) as never
      if (path.startsWith('merge_requests/3/discussions')) {
        if (firstRequest) { firstRequest = false; requested.resolve(); return await response.promise as never }
        return discussions as never
      }
      if (path.includes('?state=all')) return [] as never
      throw new Error(path)
    })
    h.receive.mockImplementation(trigger => {
      const result = h.engine.receive(trigger)
      if (stage === 'after the first note' && trigger.meta.noteId === 1) enable(false)
      return result
    })
    const polling = pollGitlab(h.ctx)
    const stopped = expect(polling).rejects.toThrow('GitLab poll stopped')
    await requested.promise
    if (stage === 'waiting for discussions') enable(false)
    response.resolve(discussions)
    await stopped
    const notes = () => h.store.read.recentTriggers(0, 100).filter(trigger => trigger.meta.noteId)
    expect(notes().map(trigger => trigger.meta.noteId)).toEqual(stage === 'after the first note' ? [1] : [])
    expect(h.store.get(KV.gitlab.cursor(id))).toBe(at)
    expect(h.store.get(KV.gitlab.since)).toBe(at)
    expect(h.store.tickets.get('task')?.follows?.[0]?.closed).toBeUndefined()
    h.receive.mockImplementation(trigger => h.engine.receive(trigger))
    enable(true)
    await pollGitlab(h.ctx)
    expect(notes().map(trigger => trigger.meta.noteId).sort()).toEqual([1, 2])
    for (const trigger of notes()) expect(h.store.triggers.disposition(trigger.id)?.filtered).toBeUndefined()
    expect(h.store.get(KV.gitlab.cursor(id))).toBeDefined()
    expect(h.store.get(KV.gitlab.cursor(id))).not.toBe(at)
    await pollGitlab(h.ctx)
    expect(notes()).toHaveLength(2)
  })

  it.each([['!', '%21'], ["'", '%27'], ['(', '%28'], [')', '%29'], ['*', '%2A'], ['~', '%7E']])('reads files and directories containing %s through real Commands', async (char, encoded) => {
    const h = harness(), path = `src/${char}/page.ts`
    const run = vi.spyOn(h.commands, 'run')
      .mockResolvedValueOnce(JSON.stringify({ encoding: 'base64', content: Buffer.from('source text').toString('base64') }))
      .mockResolvedValueOnce(JSON.stringify([{ name: 'child.ts' }]))
    expect(await readGitlabRepositoryPath(h.commands, path, 'file')).toBe('source text')
    expect(await readGitlabRepositoryPath(h.commands, path, 'directory')).toBe('child.ts')
    expect(run.mock.calls).toEqual([
      [account.cli, ['api', '--hostname', account.host, `projects/42/repository/files/src%2F${encoded}%2Fpage.ts?ref=HEAD`, '--method', 'GET']],
      [account.cli, ['api', '--hostname', account.host, `projects/42/repository/tree?path=src%2F${encoded}%2Fpage.ts&per_page=100&page=1`, '--method', 'GET']],
    ])
  })
})

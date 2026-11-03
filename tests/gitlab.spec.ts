import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, key, type Assessor, type Executor, type OutboundMessage, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { apply, GitlabConfigSchema, gitlabKind, pollRound, validBaseUrl } from '../src/sources/gitlab.ts'
import { createGitlabApi, GitlabHttpError, GitlabTokenError, RestGitlabApi } from '../src/sources/gitlab-api.ts'
import { gitlabLink, gitlabMarker, sendNote } from '../src/sources/gitlab-channel.ts'
import { readGitlabContext } from '../src/sources/gitlab-read.ts'
import { GitlabIssueSchema, GitlabMergeRequestSchema, GitlabNoteSchema, gitlabThreadId, issueTrigger, mentions,
  mergeRequestTrigger, noteTrigger, type GitlabIssue, type GitlabKind, type GitlabMergeRequest, type GitlabNote, type GitlabRef, type GitlabUser }
  from '../src/sources/gitlab-trigger.ts'
import type { GitlabApi } from '../src/sources/gitlab-api.ts'
import { testDeployment } from './fixtures/deployment.ts'

const TOKEN_ENV = 'DSH_SUPERAGENT_GITLAB_TOKEN'
const BASE = 'https://gitlab.example.com'
const PROJECT = 'acme/widgets'
const REF_URL = `${BASE}/${PROJECT}/-/issues/12`
const REF: GitlabRef & { url: string } = { baseUrl: BASE, project: PROJECT, kind: 'issue', iid: 12, url: REF_URL }
const user = (username: string, bot = false): GitlabUser => ({ id: 7, username, bot })
const issue = (overrides: Record<string, unknown> = {}): GitlabIssue => GitlabIssueSchema.parse({ id: 100, iid: 12, project_id: 5,
  title: 'Fix the button', description: 'It is blue', state: 'opened', created_at: '2026-11-03T00:00:00.000Z',
  updated_at: '2026-11-03T00:00:00.000Z', web_url: REF.url, author: user('alice'), ...overrides })
const pull = (overrides: Record<string, unknown> = {}): GitlabMergeRequest => GitlabMergeRequestSchema.parse({ id: 200, iid: 7,
  project_id: 5, title: 'Fix the margin', description: '', state: 'opened', created_at: '2026-11-03T00:00:00.000Z',
  updated_at: '2026-11-03T00:00:00.000Z', web_url: `${BASE}/${PROJECT}/-/merge_requests/7`, author: user('alice'),
  source_branch: 'fix', target_branch: 'main', ...overrides })
const note = (overrides: Record<string, unknown> = {}): GitlabNote => GitlabNoteSchema.parse({ id: 2, body: 'Please fix it',
  author: user('alice'), created_at: '2026-11-03T00:00:00.000Z', updated_at: '2026-11-03T00:00:00.000Z', ...overrides })
const published = (text: string, id = 'reply-1'): OutboundMessage =>
  ({ id, kind: 'reply', text, channel: { source: 'gitlab', thread: 'gitlab:issue:12',
    address: { baseUrl: BASE, project: PROJECT, kind: 'issue', iid: '12', url: REF_URL } } })
/** A host on a real Store with the GitLab kind registered, plus a fake GitLab API for the polling tests. */
function host(config: Record<string, unknown> = {}, register = true, configured = true) {
  const directory = mkdtempSync(join(tmpdir(), 'gitlab-source-'))
  const store = new Store(join(directory, 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    eval: { mode: 'auto' },
    sources: { gitlab: { enabled: true, config: { baseUrl: BASE, project: PROJECT, ...config } } },
    policy: { sources: { gitlab: { allowed: [{ id: 'alice' }] } } },
  }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  if (register) sources.register(gitlabKind)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor,
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const deps: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources,
    deployment: testDeployment(), ready: Promise.resolve(), configured: () => configured, receive }
  const close = () => { store.close(); rmSync(directory, { recursive: true, force: true }) }
  return { ...deps, store, engine, receive, health: board.all, close,
    ctx: sourceContextOf(deps, gitlabKind), context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(deps, kind) }
}
/** A fake API for a poll round; tests override only the reads they exercise. */
function api(overrides: Partial<GitlabApi> = {}): GitlabApi & { postNote: ReturnType<typeof vi.fn> } {
  const base: GitlabApi = {
    baseUrl: BASE, project: PROJECT,
    me: async () => user('agent-bot', true),
    getIssue: async () => issue(),
    getMergeRequest: async () => pull(),
    updatedIssues: async () => [],
    updatedMergeRequests: async () => [],
    notes: async () => [],
    notesPage: async () => ({ items: [] }),
    findNote: async () => false,
    postNote: async () => {},
  }
  return { ...base, ...overrides, postNote: vi.fn(overrides.postNote ?? base.postNote) }
}
afterEach(() => { vi.restoreAllMocks(); delete process.env[TOKEN_ENV] })

describe('GitLab Source', () => {
  it('normalizes Issue, merge request and note payloads into Triggers with GitLab-specific Thread ids', () => {
    const body = issue({ description: 'It is blue, @agent-bot please look' })
    const trigger = issueTrigger(body, REF, 'agent-bot')
    expect(trigger).toMatchObject({ id: key('gitlab-issue', PROJECT, '12'), source: 'gitlab',
      threads: [{ source: 'gitlab', id: 'issue:12' }], actor: { source: 'gitlab', id: 'alice' }, human: true,
      addressed: 'mention', at: '2026-11-03T00:00:00.000Z', url: REF.url,
      channel: { source: 'gitlab', thread: 'gitlab:issue:12',
        address: { baseUrl: BASE, project: PROJECT, kind: 'issue', iid: '12', url: REF.url } },
      meta: { project: PROJECT, kind: 'issue', iid: 12, thread: 'issue:12', messageId: 'root' } })
    const merge = mergeRequestTrigger(pull(), { ...REF, kind: 'merge_request', iid: 7 }, 'agent-bot')
    expect(merge).toMatchObject({ id: key('gitlab-merge-request', PROJECT, '7'), threads: [{ source: 'gitlab', id: 'mr:7' }],
      meta: { kind: 'merge_request', iid: 7, thread: 'mr:7', sourceBranch: 'fix', targetBranch: 'main' } })
    expect(merge.addressed).toBeUndefined()
    // A note is its own Trigger; an edit is a new version because `updated_at` is part of the id.
    const note = noteTrigger(GitlabNoteSchema.parse({ id: 2, body: '@agent-bot please look', author: user('alice'),
      created_at: '2026-11-03T00:00:00.000Z', updated_at: '2026-11-03T00:00:00.000Z' }), REF, 'agent-bot')!
    expect(note).toMatchObject({ id: key('gitlab-note', PROJECT, 'issue', '12', '2', '2026-11-03T00:00:00.000Z'),
      threads: [{ source: 'gitlab', id: 'issue:12' }], addressed: 'mention', url: `${REF_URL}#note_2`,
      channel: { address: { kind: 'issue', iid: '12', url: `${REF_URL}#note_2` } }, meta: { noteId: 2, messageId: '2' } })
    // GitLab's system notes and the bot's own notes never become Triggers.
    expect(noteTrigger(GitlabNoteSchema.parse({ id: 3, body: 'changed the description', system: true, author: user('alice'),
      created_at: '2026-11-03T00:00:00.000Z' }), REF, 'agent-bot')).toBeUndefined()
    expect(noteTrigger(GitlabNoteSchema.parse({ id: 4, body: 'done', author: user('agent-bot', true),
      created_at: '2026-11-03T00:00:00.000Z' }), REF, 'agent-bot')).toBeUndefined()
    expect(noteTrigger(GitlabNoteSchema.parse({ id: 5, body: '   ', author: user('alice'),
      created_at: '2026-11-03T00:00:00.000Z' }), REF, 'agent-bot')).toBeUndefined()
    // A bot's note is non-human, and a mention is only a mention at a user boundary.
    expect(noteTrigger(GitlabNoteSchema.parse({ id: 6, body: 'look @agent-bot', author: user('renovate-bot', true),
      created_at: '2026-11-03T00:00:00.000Z' }), REF, 'agent-bot')).toMatchObject({ human: false })
    expect(mentions('@agent-bot hi', 'agent-bot')).toBe(true)
    expect(mentions('hi @agent-bot.', 'agent-bot')).toBe(true)
    expect(mentions('hi @agent-botx', 'agent-bot')).toBe(false)
    expect(mentions('mail alice@agent-bot.example', 'agent-bot')).toBe(false)
    expect(gitlabThreadId('merge_request', 7)).toBe('mr:7')
  })

  it('validates the instance URL and project path, keeping the default instance inert', () => {
    expect(validBaseUrl('https://gitlab.example.com')).toBe(true)
    expect(validBaseUrl('https://example.com/gitlab')).toBe(true)
    expect(validBaseUrl('http://localhost:8080')).toBe(true)
    expect(validBaseUrl('http://gitlab.example.com')).toBe(false)
    expect(validBaseUrl('https://user:secret@gitlab.example.com')).toBe(false)
    expect(validBaseUrl('https://gitlab.example.com?x=1')).toBe(false)
    expect(GitlabConfigSchema.parse({})).toMatchObject({ baseUrl: '', project: '', pollSeconds: 60, failuresBeforeError: 3,
      observeIssues: false, observeMergeRequests: false, observeNotes: false })
    expect(GitlabConfigSchema.parse({ project: 'group/subgroup/project' }).project).toBe('group/subgroup/project')
    expect(() => GitlabConfigSchema.parse({ project: '/leading' })).toThrow()
    expect(() => GitlabConfigSchema.parse({ project: 'group/../project' })).toThrow()
    expect(() => GitlabConfigSchema.parse({ baseUrl: 'http://gitlab.example.com' })).toThrow()
  })

  it('reports the receiving scope and the admission rows the Policy shows', () => {
    const config = GitlabConfigSchema.parse({ baseUrl: BASE, project: PROJECT, observeIssues: true, observeNotes: true })
    expect(gitlabKind.scope!({ meta: { kind: 'issue' } }, config)).toEqual({ listened: true, observed: true, row: 'issues' })
    expect(gitlabKind.scope!({ meta: { kind: 'merge_request' } }, config)).toEqual({ listened: true, observed: false, row: 'merge_requests' })
    expect(gitlabKind.scope!({ meta: { kind: 'issue', noteId: 2 } }, config)).toEqual({ listened: true, observed: true, row: 'comments' })
    expect(gitlabKind.scope!({ meta: { kind: 'something-else' } }, config)).toEqual({ listened: true, observed: false })
    const rows = gitlabKind.policy!.rows!({ observeIssues: true })
    expect(rows.map(row => row.id)).toEqual(['issues', 'merge_requests', 'comments'])
    expect(rows[0]).toMatchObject({ cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true } })
    expect(rows[1]).toMatchObject({ cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } })
    // Unaddressed notes are inferred candidates only where the Source observes notes; a mention remains explicit.
    expect(rows[2]).toMatchObject({ cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } })
  })

  it('finds a Thread from the ways a person writes an Issue, merge request or page link', () => {
    expect(gitlabKind.find!('#12')).toEqual({ threads: ['gitlab:issue:12'], terms: [] })
    expect(gitlabKind.find!('!7')).toEqual({ threads: ['gitlab:mr:7'], terms: [] })
    expect(gitlabKind.find!('gitlab:mr:7')).toEqual({ threads: ['gitlab:mr:7'], terms: [] })
    expect(gitlabKind.find!(`${BASE}/${PROJECT}/-/merge_requests/7#note_2`)).toEqual({ threads: ['gitlab:mr:7'], terms: [] })
    expect(gitlabKind.find!('nothing')).toEqual({ threads: [], terms: [] })
  })

  it('takes in a new Issue and a mention note once, then replays them as duplicates and advances the cursor', async () => {
    const h = host()
    const at = new Date(Date.now() + 60_000).toISOString()
    const list = [issue({ created_at: at, updated_at: at })]
    const notes = [note({ id: 2, body: '@agent-bot please look', created_at: at, updated_at: at }),
      note({ id: 3, body: 'changed the description', system: true, created_at: at, updated_at: at })]
    const gitlab = api({ updatedIssues: async () => list, notes: async () => notes })
    expect(await pollRound(h.ctx, new AbortController().signal, gitlab)).toEqual({ issues: 1, mergeRequests: 0, notes: 1 })
    expect(h.receive.mock.results.map(result => result.value)).toEqual(['stored', 'stored'])
    const trigger = h.receive.mock.calls[1]![0] as Trigger
    expect(h.engine.candidate(trigger.id)?.strength).toBe('explicit')
    expect(h.store.get(KV.gitlab.since)).toBeDefined()
    expect(h.store.get(KV.gitlab.notes('gitlab:issue:12'))).toBeDefined()
    // The 5-second overlap can re-read the same items; stable ids make that harmless.
    expect(await pollRound(h.ctx, new AbortController().signal, gitlab)).toEqual({ issues: 1, mergeRequests: 0, notes: 1 })
    expect(h.receive.mock.results.slice(2).map(result => result.value)).toEqual(['duplicate', 'duplicate'])
    h.close()
  })

  it('drops an unaddressed note unless notes are observed or a Ticket follows the Thread', async () => {
    const at = new Date(Date.now() + 60_000).toISOString()
    // The Issue predates the interval, so only its note is in question and no Ticket's Thread exists yet.
    const gitlab = () => api({ updatedIssues: async () => [issue({ created_at: '2020-01-01T00:00:00.000Z', updated_at: at })],
      notes: async () => [note({ id: 2, body: 'just a status update', created_at: at, updated_at: at })] })
    const quiet = host()
    await pollRound(quiet.ctx, new AbortController().signal, gitlab())
    expect(quiet.receive).not.toHaveBeenCalled()
    quiet.close()
    const observed = host({ observeNotes: true })
    await pollRound(observed.ctx, new AbortController().signal, gitlab())
    expect(observed.receive).toHaveBeenCalledTimes(1)
    observed.close()
    const followed = host()
    followed.store.threads.save({ key: 'gitlab:issue:12', ref: { source: 'gitlab', id: 'issue:12' },
      createdAt: at, subscriptions: ['ticket'], correlated: [], pending: [], meta: {} })
    await pollRound(followed.ctx, new AbortController().signal, gitlab())
    expect(followed.receive).toHaveBeenCalledTimes(1)
    followed.close()
  })

  it('reads merge requests too, and leaves the cursor for the next round when a read fails', async () => {
    const h = host()
    const at = new Date(Date.now() + 60_000).toISOString()
    const gitlab = api({ updatedMergeRequests: async () => [pull({ created_at: at, updated_at: at })] })
    expect(await pollRound(h.ctx, new AbortController().signal, gitlab)).toEqual({ issues: 0, mergeRequests: 1, notes: 0 })
    expect(h.receive).toHaveBeenCalledTimes(1)
    h.close()
    const broken = host()
    await expect(pollRound(broken.ctx, new AbortController().signal, api({ updatedIssues: async () => { throw new GitlabHttpError(500, 'boom') } })))
      .rejects.toThrow('1 GitLab reads failed')
    expect(broken.store.get(KV.gitlab.since)).toBeDefined()
    expect(broken.store.get(KV.gitlab.notes('gitlab:issue:12'))).toBeUndefined()
    broken.close()
  })

  it('reads a Thread page and its root description for assessments', async () => {
    const trigger = noteTrigger(note({ id: 2, body: 'Please look' }), REF, 'agent-bot')!
    const gitlab = api({ notesPage: async (_kind: GitlabKind, _iid: number, page: number) => page === 1 ? { items: [note()], next: 2 } : { items: [note({ id: 9, body: 'later' })] } })
    const first = await readGitlabContext(gitlab, trigger, 'thread', undefined)
    expect(first.messages).toEqual([{ id: '2', from: 'alice', at: '2026-11-03T00:00:00.000Z', text: 'Please fix it' }])
    expect(first.next).toBe('2')
    expect((await readGitlabContext(gitlab, trigger, 'thread', '2')).messages).toEqual([
      { id: '9', from: 'alice', at: '2026-11-03T00:00:00.000Z', text: 'later' }])
    expect((await readGitlabContext(gitlab, trigger, 'root', undefined)).messages).toEqual([{ id: 'root', from: 'alice',
      at: '2026-11-03T00:00:00.000Z', text: 'Fix the button\n\nIt is blue', url: REF.url }])
    expect(await readGitlabContext(gitlab, trigger, 'parent', undefined)).toMatchObject({ messages: [], status: 'no_parent' })
  })

  it('posts one note per message with a hidden marker, and only a 404 is gone', async () => {
    const sent = api()
    expect(await sendNote(sent, published('On it'))).toBe('sent')
    expect(sent.postNote).toHaveBeenCalledWith('issue', 12, `On it\n\n${gitlabMarker('reply-1')}`)
    const duplicate = api({ findNote: async () => true })
    expect(await sendNote(duplicate, published('On it'))).toBe('sent')
    expect(duplicate.postNote).not.toHaveBeenCalled()
    const gone = api({ postNote: async () => { throw new GitlabHttpError(404, 'Not found') } })
    expect(await sendNote(gone, published('On it'))).toBe('gone')
    const failed = api({ postNote: async () => { throw new GitlabHttpError(500, 'boom') } })
    await expect(sendNote(failed, published('On it'))).rejects.toThrow('boom')
    expect(gitlabLink({ baseUrl: BASE, project: PROJECT, kind: 'issue', iid: '12', url: REF_URL }, {})).toEqual({ url: REF_URL,
      label: { zh: 'GitLab Issue #12', en: 'GitLab issue #12' } })
    expect(gitlabLink({ baseUrl: BASE, project: PROJECT, kind: 'merge_request', iid: '7' }, {})).toMatchObject({
      url: `${BASE}/${PROJECT}/-/merge_requests/7` })
  })

  it('calls REST API v4 with its token, follows x-next-page, and reports HTTP failures with their status', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const transport = async (url: URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ id: 1, username: 'agent-bot' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const client = new RestGitlabApi(BASE, PROJECT, 'secret-token', transport)
    expect(await client.me()).toEqual({ id: 1, username: 'agent-bot', bot: false })
    expect(calls[0]!.url).toBe(`${BASE}/api/v4/user`)
    expect((calls[0]!.init!.headers as Record<string, string>)['PRIVATE-TOKEN']).toBe('secret-token')
    const paged = async (url: URL): Promise<Response> => {
      calls.push({ url: String(url) })
      const page = Number(new URL(String(url)).searchParams.get('page') ?? '1')
      return new Response(JSON.stringify([{ id: 1, body: 'one', author: { id: 1, username: 'alice' },
        created_at: '2026-11-03T00:00:00.000Z' }]), { status: 200, headers: page === 1 ? { 'x-next-page': '2' } : {} })
    }
    const api = new RestGitlabApi(BASE, PROJECT, 'secret-token', paged)
    const page = await api.notesPage('issue', 12, 1)
    expect(page.next).toBe(2)
    expect(calls.at(-1)!.url).toContain(`/projects/${encodeURIComponent(PROJECT)}/issues/12/notes`)
    const missing = async (): Promise<Response> => new Response(JSON.stringify({ message: '404 Project Not Found' }), { status: 404 })
    const absent = new RestGitlabApi(BASE, PROJECT, 'secret-token', missing)
    await expect(absent.getIssue(12)).rejects.toMatchObject({ status: 404, message: 'GitLab answered HTTP 404: 404 Project Not Found' })
    delete process.env[TOKEN_ENV]
    expect(() => createGitlabApi({ baseUrl: BASE, project: PROJECT })).toThrow(GitlabTokenError)
  })

  it('registers its kind and names setup, configuration and the token on its health', async () => {
    const run = async (options: { configured?: boolean; token?: string; config?: Record<string, unknown> }) => {
      const h = host(options.config ?? {}, false)
      if (options.token) process.env[TOKEN_ENV] = options.token
      else delete process.env[TOKEN_ENV]
      const effects: (() => unknown)[] = []
      apply({ orchestrator: h, effect: (effect: () => () => unknown) => { effects.push(effect()) } } as never)
      await vi.waitFor(() => expect(h.health.gitlab).toBeDefined())
      const registered = h.sources.kind('gitlab')
      const health = { ...h.health }
      for (const dispose of effects) await dispose()
      h.close()
      return { registered, health }
    }
    const unconfigured = await run({ config: { baseUrl: '', project: '' } })
    expect(unconfigured.registered).toBe(gitlabKind)
    expect(unconfigured.health.gitlab).toMatchObject({ state: 'paused', code: 'gitlabUnconfigured' })
    expect((await run({ config: { baseUrl: BASE, project: PROJECT } })).health.gitlab).toMatchObject({ state: 'paused', code: 'gitlabTokenUnset' })
    // A configured Source still waits for the deployment check before it reads anything.
    const waiting = host({ baseUrl: BASE, project: PROJECT }, false, false)
    const effects: (() => unknown)[] = []
    apply({ orchestrator: waiting, effect: (effect: () => () => unknown) => { effects.push(effect()) } } as never)
    await vi.waitFor(() => expect(waiting.health.gitlab).toBeDefined())
    expect(waiting.health.gitlab).toMatchObject({ state: 'paused', code: 'setupPending' })
    for (const dispose of effects) await dispose()
    waiting.close()
  })
})

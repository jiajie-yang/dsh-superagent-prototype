import { chmodSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Effects } from '../src/app/effects.ts'
import { registerGitlabWebhook } from '../src/app/gitlab-webhook.ts'
import { Store } from '../src/app/store.ts'
import { CliError, Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { gitlabKind, pollGitlab } from '../src/sources/gitlab.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

const path = '/webhooks/gitlab', token = 'test-secret'
const headers = { 'content-type': 'application/json', 'x-gitlab-token': token, 'x-gitlab-instance': 'https://gitlab.example.com' }
const author = { id: 9, username: 'alice' }
const now = () => new Date().toISOString()
function issue(at: string) {
  return { id: 100, iid: 3, title: '@agent-bot fix', description: 'description', author, state: 'opened',
    created_at: at, updated_at: at, web_url: 'https://gitlab.example.com/acme/widgets/-/issues/3' }
}
function note(id: number, at: string, action = 'create') {
  return { object_kind: 'note', project_id: 42, project: { id: 42 }, issue: { id: 100, iid: 3 }, object_attributes: {
    id, action, note: '@agent-bot review', created_at: at, updated_at: at, author_id: 9, noteable_type: 'Issue', noteable_id: 100, discussion_id: 'd1',
  } }
}
async function host() {
  const h = await startRuntime(undefined, 'gitlab')
  const { store } = h.runtime, settings = store.settings()
  store.saveSettings({ ...settings, sources: { ...settings.sources, gitlab: { enabled: true,
    config: { ...settings.sources.gitlab!.config, webhookEnabled: true } } }, policy: { ...settings.policy,
    sources: { ...settings.policy.sources, gitlab: { allowed: [{ id: 'https%3A%2F%2Fgitlab.example.com:9' }] } } } })
  writeFileSync(join(h.directory, 'gitlab-webhook-token'), token, { mode: 0o600 })
  return h
}
const send = (h: Host, delivery: string, body: unknown, override: Record<string, string> = {}) =>
  h.request('POST', path, body, { ...headers, 'idempotency-key': delivery, ...override })
const gitlabTriggers = (h: Host) => h.runtime.store.read.recentTriggers().filter(t => t.source === 'gitlab')

it('reports receiver readiness before delivery and shows the last recorded receipt', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  let h: Host | undefined
  try {
    const current = h = await host()
    const tokenPath = join(current.directory, 'gitlab-webhook-token')
    const receiver = () => current.runtime.health.gitlabWebhookReceiver
    unlinkSync(tokenPath)
    vi.advanceTimersByTime(30_000)
    expect(receiver()).toMatchObject({ state: 'error', detail: expect.stringContaining('0600') })
    writeFileSync(tokenPath, token, { mode: 0o644 })
    vi.advanceTimersByTime(30_000)
    expect(receiver()).toMatchObject({ state: 'error', detail: expect.stringContaining('0644') })
    expect(await send(current, 'unsafe', note(5, now()))).toMatchObject({ status: 503 })
    chmodSync(tokenPath, 0o400)
    vi.advanceTimersByTime(30_000)
    expect(receiver()).toMatchObject({ state: 'starting' })
    expect(await send(current, 'ignored', { object_kind: 'push', project: { id: 42 } })).toMatchObject({ status: 204 })
    expect(receiver()?.state).toBe('starting')
    const event = note(5, now())
    const payload = { ...event, object_attributes: { ...event.object_attributes, note: 'ordinary comment' } }
    expect(await send(current, 'accepted', payload)).toMatchObject({ status: 200 })
    const recorded = receiver()
    expect(recorded).toMatchObject({ state: 'ready', detail: expect.stringContaining('Last recorded') })
    expect(await send(current, 'accepted', payload)).toMatchObject({ status: 200 })
    expect(receiver()).toEqual(recorded)
  } finally {
    try { await h?.stop() } finally { vi.useRealTimers() }
  }
})

it('authenticates the ingress, ignores other projects and queues only bounded requests on the webhook path', async () => {
  const h = await host()
  try {
    const event = note(5, now())
    expect(await send(h, 'bad-token', event, { 'x-gitlab-token': 'bad' })).toMatchObject({ status: 401 })
    expect(await send(h, 'bad-host', event, { 'x-gitlab-instance': 'https://other.example.com' })).toMatchObject({ status: 403 })
    expect(await send(h, 'large', { ...event, junk: 'a'.repeat(256 * 1024) })).toMatchObject({ status: 413 })
    expect(await send(h, 'foreign', { ...event, project_id: 9 })).toMatchObject({ status: 204 })
    expect(await h.request('GET', path, undefined, headers)).toMatchObject({ status: 405 })
    expect(await h.request('POST', '/orchestrator/api/state', event, headers)).toMatchObject({ status: 403 })
    expect(h.runtime.effects.pending('gitlabWebhook')).toBe(false)
  } finally { await h.stop() }
})

it('acknowledges unsupported GitLab payloads without queuing them and rejects malformed supported events', async () => {
  const h = await host()
  try {
    const project = { id: 42 }
    for (const kind of ['push', 'tag_push']) {
      expect(await send(h, kind, { object_kind: kind, project })).toMatchObject({ status: 204 })
    }
    const event = note(5, now())
    expect(await send(h, 'commit-note', { object_kind: 'note', project, object_attributes: {
      ...event.object_attributes, noteable_type: 'Commit', noteable_id: null,
    } })).toMatchObject({ status: 204 })
    expect(await send(h, 'malformed-issue', { object_kind: 'issue', project })).toMatchObject({ status: 400 })
    expect(await send(h, 'malformed-note', { ...event, object_attributes: { noteable_type: 'Issue' } }))
      .toMatchObject({ status: 400 })
    expect(h.runtime.effects.pending('gitlabWebhook')).toBe(false)
    expect(gitlabTriggers(h)).toHaveLength(0)
  } finally { await h.stop() }
})

it('uses scoped API reads, keeps the discussion ID, deduplicates retries and treats edits as context', async () => {
  const h = await host()
  try {
    const activation = Date.parse(h.runtime.store.settingsHistory()[0]!.savedAt)
    const time = activation + 60_000, at = new Date(time).toISOString()
    vi.spyOn(Date, 'now').mockReturnValue(time)
    const object = issue(new Date(activation + 1_000).toISOString())
    const markdownExample = '\n```markdown\n![Example](/uploads/example/image.png)\n```'
    object.description = '![Screenshot [failed]](/uploads/abc/image(1).png)' + markdownExample
    const discussion = { id: 'd1', notes: [5, 6].map(id => ({
      id, body: '@agent-bot verified text', author, created_at: at, updated_at: at,
    })) }
    const read = vi.spyOn(Commands.prototype, 'gitlab').mockImplementation(async endpoint => {
      if (endpoint === 'issues/3') return object as never
      if (endpoint === 'issues/3/discussions/d1') return discussion as never
      if (endpoint === 'issues/3/discussions?per_page=100&page=1') return [discussion] as never
      throw new Error(`Unexpected API read: ${endpoint}`)
    })
    const bodyHook = { object_kind: 'issue', project: { id: 42 }, object_attributes: { iid: 3, action: 'open',
      author_id: author.id, title: object.title, description: '![Screenshot [failed]](https://gitlab.example.com/-/project/42/uploads/abc/image(1).png)' + markdownExample } }
    object.updated_at = new Date(Date.parse(at) + 1000).toISOString()
    await send(h, 'early-update', { ...bodyHook, object_attributes: { ...bodyHook.object_attributes, action: 'update' } })
    await h.runtime.idle()
    expect(gitlabTriggers(h).find(t => !t.meta.noteId)).toMatchObject({ human: false, meta: { contextOnly: true } })
    // Even a later reconciliation baseline must not discard an opening after activation.
    h.runtime.store.set(KV.gitlab.baseline, new Date(Date.now() + 60_000).toISOString())
    expect(await send(h, 'open', bodyHook))
      .toMatchObject({ status: 200 })
    await h.runtime.idle()
    await send(h, 'duplicate-open-different-delivery', bodyHook)
    await h.runtime.idle()
    expect(gitlabTriggers(h).filter(t => !t.meta.noteId && t.human)).toEqual([
      expect.objectContaining({ addressed: 'mention', text: `@agent-bot fix\n${object.description}` }),
    ])

    const create = note(5, at)
    const first = { ...create, object_attributes: { ...create.object_attributes, discussion_id: null, noteable_id: null } }
    expect(await send(h, 'note', first)).toMatchObject({ status: 200 })
    await h.runtime.idle()
    const calls = read.mock.calls.length
    expect(await send(h, 'note', first)).toMatchObject({ status: 200 })
    await h.runtime.idle()
    expect(read).toHaveBeenCalledTimes(calls)
    await send(h, 'same-note-new-delivery', first)
    const edit = note(6, at, 'update')
    await send(h, 'edited-note', { ...edit, object_attributes: { ...edit.object_attributes, discussion_id: null } })
    await h.runtime.idle()
    const triggers = gitlabTriggers(h)
    expect(triggers.filter(t => t.meta.noteId === 5)).toHaveLength(1)
    expect(triggers.find(t => t.meta.noteId === 5)).toMatchObject({ human: true, addressed: 'mention', text: '@agent-bot verified text',
      channel: { address: { discussionId: 'd1' } } })
    expect(triggers.find(t => t.meta.noteId === 6)).toMatchObject({ human: false, meta: { contextOnly: true } })
    expect(triggers.find(t => t.meta.noteId === 6)?.addressed).toBeUndefined()
    expect([...new Set(read.mock.calls.map(([url]) => url))]).toEqual(['issues/3', 'issues/3/discussions?per_page=100&page=1', 'issues/3/discussions/d1'])
    expect(read.mock.calls.filter(([url]) => url.includes('?per_page='))).toHaveLength(1)
  } finally { await h.stop() }
})

it('acknowledges GitLab test deliveries for history without admitting work', async () => {
  const h = await host()
  try {
    const activation = Date.parse(h.runtime.store.settingsHistory()[0]!.savedAt)
    const before = new Date(activation - 60_000).toISOString(), after = new Date(activation + 1_000).toISOString()
    const object = issue(before)
    const discussion = { id: 'd1', notes: [before, after].map((at, index) => ({
      id: 5 + index, body: '@agent-bot fix', author, created_at: at, updated_at: at,
    })) }
    vi.spyOn(Commands.prototype, 'gitlab').mockImplementation(async endpoint => (endpoint === 'issues/3' ? object : discussion) as never)
    const opening = { object_kind: 'issue', project: { id: 42 }, object_attributes: { iid: 3, action: 'open',
      author_id: author.id, title: object.title, description: object.description } }
    expect((await send(h, 'test-open', opening)).status).toBe(200)
    expect((await send(h, 'test-note', note(5, before))).status).toBe(200)
    await h.runtime.idle()
    expect(h.runtime.health.gitlabWebhookReceiver?.state).toBe('ready')
    expect(h.candidates()).toEqual([])
    expect(gitlabTriggers(h).filter(trigger => trigger.human)).toEqual([])

    expect((await send(h, 'new-note', note(6, after))).status).toBe(200)
    await h.runtime.idle()
    expect(h.candidates()).toHaveLength(1)
    expect(gitlabTriggers(h).filter(trigger => trigger.human)).toMatchObject([{ addressed: 'mention', meta: { noteId: 6 } }])
  } finally { await h.stop() }
})

it('reconciles active tickets only and reads current MR state before applying a terminal hook', async () => {
  const h = await host()
  try {
    const at = now()
    const read = vi.spyOn(Commands.prototype, 'gitlab').mockRejectedValue(new Error('unexpected read'))
    const source = h.runtime.context(gitlabKind)
    await pollGitlab(source)
    expect(read).not.toHaveBeenCalled()
    const { ticket, sessionId } = await h.acceptedTicket(feishu('3', 'fix this'))
    const merge = { ...issue(at), author: { id: 7, username: 'agent-bot' }, source_project_id: 42, target_project_id: 42,
      source_branch: `agent/${ticket.execution!.name}`, web_url: 'https://gitlab.example.com/acme/widgets/-/merge_requests/3' }
    let remote = merge
    let reopenDuringCatchup = false
    read.mockImplementation(async endpoint => {
      if (endpoint === 'merge_requests/3') return remote as never
      if (endpoint === 'merge_requests/3/discussions?per_page=100&page=1') {
        if (reopenDuringCatchup) remote = merge
        return [] as never
      }
      throw new Error(`Unexpected API read: ${endpoint}`)
    })
    await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'ready', mr_iid: 3 })
    read.mockClear()
    await pollGitlab(source)
    expect(read.mock.calls.map(([url]) => url)).toEqual(['merge_requests/3', 'merge_requests/3/discussions?per_page=100&page=1'])
    const event = { object_kind: 'merge_request', project: { id: 42 }, object_attributes: { iid: 3, action: 'merge' } }
    read.mockRejectedValueOnce(new CliError('rate limited', 429))
    await send(h, '429', event); await h.runtime.idle()
    const calls = read.mock.calls.length
    await pollGitlab(source)
    expect(read).toHaveBeenCalledTimes(calls)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000)
    await h.runtime.idle()
    remote = { ...merge, state: 'closed' }; reopenDuringCatchup = true
    read.mockClear()
    await pollGitlab(source)
    expect(read.mock.calls.map(([url]) => url)).toEqual(['merge_requests/3', 'merge_requests/3/discussions?per_page=100&page=1', 'merge_requests/3'])
    expect(h.runtime.store.tickets.get(ticket.id)?.ended).toBeUndefined()
    remote = { ...merge, state: 'merged' }; reopenDuringCatchup = true
    await send(h, 'stale-close', event); await h.runtime.idle()
    expect(h.runtime.store.tickets.get(ticket.id)?.ended).toBeUndefined()
    remote = { ...merge, state: 'merged' }; reopenDuringCatchup = false
    await send(h, 'merge', event); await h.runtime.idle()
    expect(h.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('merged')
    await send(h, 'old-open', { ...event, object_attributes: { iid: 3, action: 'open' } }); await h.runtime.idle()
    expect(h.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('merged')
  } finally { await h.stop() }
})

it('reopens the durable inbox and backs off a rate-limited delivery without resetting it on redelivery', async () => {
  const h = await host()
  const db = join(h.directory, 'webhook-inbox.sqlite')
  const request = h.ctx.get('webServer')!
  let handler: Parameters<typeof request.register>[0]['handler']
  const fakeContext = { webServer: { register: (route: Parameters<typeof request.register>[0]) => {
    handler = route.handler
    return () => {}
  } } } as Context
  let store = new Store(db)
  let effects = new Effects(store, new HealthBoard())
  const mount = () => registerGitlabWebhook(fakeContext, { store, effects, machine: { stateDir: h.directory },
    lifetime: h.runtime.lifetime, context: () => h.runtime.context(gitlabKind) }, new HealthBoard().claim('receiver'))
  const deliver = async () => {
    const { Readable } = await import('node:stream')
    const at = now()
    const req = Object.assign(Readable.from([JSON.stringify(note(5, at))]), { method: 'POST', url: path, headers: { ...headers, 'webhook-id': 'persistent' } })
    let status = 0
    await handler(req as never, { writeHead: (code: number) => { status = code }, end: () => {} } as never)
    return status
  }
  let unmount: (() => void) | undefined
  try {
    unmount = mount()
    expect(await deliver()).toBe(200)
    expect(effects.pending('gitlabWebhook')).toBe(true)
    await effects.drain()
    unmount()
    store.close()
    store = new Store(db)
    effects = new Effects(store, new HealthBoard())
    unmount = mount()
    const at = now()
    const api = vi.spyOn(Commands.prototype, 'gitlab').mockRejectedValueOnce(new CliError('rate limited', 429, 1, 120_000))
      .mockImplementation(async endpoint => (endpoint === 'issues/3' ? issue(at) : { id: 'd1', notes: [{
        id: 5, body: '@agent-bot fix', author, created_at: at, updated_at: at,
      }] }) as never)
    effects.start()
    await effects.idle()
    expect(effects.pending('gitlabWebhook')).toBe(true)
    expect(api).toHaveBeenCalledTimes(1)
    expect(await deliver()).toBe(200)
    await effects.idle()
    expect(api).toHaveBeenCalledTimes(1)
    store.db.exec("UPDATE effect SET due = 0 WHERE kind = 'gitlabWebhook'")
    await effects.idle()
    expect(api).toHaveBeenCalledTimes(1)
    const time = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(time + 31_000)
    await effects.idle()
    expect(api).toHaveBeenCalledTimes(1)
    clock.mockReturnValue(time + 121_000)
    await effects.idle()
    expect(effects.pending('gitlabWebhook')).toBe(false)
    expect(gitlabTriggers(h).filter(t => t.meta.noteId === 5)).toHaveLength(1)
  } finally { unmount?.(); await effects.drain(); store.close(); await h.stop() }
})

it('keeps a repeated API 404 visible and replays the original event after access is restored', async () => {
  const h = await host()
  try {
    const at = now(), time = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(time)
    const api = vi.spyOn(Commands.prototype, 'gitlab').mockRejectedValue(new CliError('not found', 404))
    const payload = { object_kind: 'issue', project: { id: 42 }, object_attributes: { iid: 3, action: 'open' } }
    expect((await send(h, 'replay', payload)).status).toBe(200)
    await h.runtime.idle()
    clock.mockReturnValue(time + 5_000)
    await h.runtime.idle()
    clock.mockReturnValue(time + 15_000)
    await h.runtime.idle()
    expect(h.runtime.health.gitlabWebhook).toMatchObject({ state: 'error', detail: expect.stringContaining('1 awaiting replay') })
    expect(h.runtime.health.gitlabWebhook?.detail).toContain('Issue #3 (delivery replay)')
    clock.mockReturnValue(time + 300_000)
    await h.runtime.idle()
    expect(api).toHaveBeenCalledTimes(3)

    const receiver = h.runtime.health.gitlabWebhookReceiver
    api.mockResolvedValue(issue(at))
    expect((await send(h, 'replay', payload)).status).toBe(200)
    await h.runtime.idle()
    expect(gitlabTriggers(h)).toHaveLength(1)
    expect(h.runtime.health.gitlabWebhook).toMatchObject({ state: 'ready', detail: 'Nothing waiting' })
    expect(h.runtime.health.gitlabWebhookReceiver).toEqual(receiver)
  } finally { await h.stop() }
})

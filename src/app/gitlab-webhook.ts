/** Authenticated GitLab ingress, separate from the loopback management API. */
import { timingSafeEqual } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key } from '../core/index.ts'
import type { GitlabAccount } from '../deployment.ts'
import { gitlabKind, gitlabMention, processGitlabHook, type GitlabConfig, type GitlabHookEvent } from '../sources/gitlab.ts'
import { gitlabCoolingDown } from '../sources/gitlab-read.ts'
import type { SourceContext } from '../sources/host.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { Effects } from './effects.ts'
import type { Store } from './store.ts'

const PATH = '/webhooks/gitlab'
const MAX_BYTES = 256 * 1024
const DAY = 24 * 3600_000
const RETENTION = 14 * DAY
const id = z.int().positive()
const envelope = z.object({ object_kind: z.string().min(1), project_id: id.optional(), project: z.object({ id }).optional(),
  object_attributes: z.unknown().optional() })
const object = z.object({ iid: id, action: z.string(), target_project_id: id.optional(),
  author_id: id.optional(), title: z.string().optional(), description: z.string().nullish() })
const parent = z.object({ id, iid: id, author_id: id.optional(), target_project_id: id.optional() })
const noteTarget = z.object({ noteable_type: z.string().min(1) })
const comment = noteTarget.extend({ id, noteable_id: id.nullish(), author_id: id.optional(),
  system: z.boolean().optional(), note: z.string().optional(), action: z.string().optional(),
  discussion_id: z.string().nullish() })

/** The payload locates an object. It never supplies a Trigger's identity, content or authorization. */
function normalize(raw: unknown, account: GitlabAccount, receivedAt: string): GitlabHookEvent | undefined {
  const event = envelope.parse(raw)
  const projectIds = [event.project_id, event.project?.id].filter(value => value !== undefined)
  if (!projectIds.length || projectIds.some(value => value !== account.projectId)) return
  if (event.object_kind === 'issue' || event.object_kind === 'merge_request') {
    const attrs = object.parse(event.object_attributes)
    if (attrs.target_project_id !== undefined && attrs.target_project_id !== account.projectId) return
    if (!['open', 'close', 'reopen', 'update', 'merge'].includes(attrs.action)) return
    return { kind: event.object_kind === 'issue' ? 'issue' : 'mr', iid: attrs.iid, receivedAt,
      ...attrs.action !== 'open' ? { contextOnly: true }
        : attrs.author_id !== undefined && attrs.title !== undefined && attrs.description !== undefined
          ? { openHash: key(String(attrs.author_id), attrs.title, attrs.description ?? '') } : {} }
  }
  if (event.object_kind !== 'note') return
  const { noteable_type } = noteTarget.parse(event.object_attributes)
  const kind = noteable_type === 'Issue' ? 'issue' : noteable_type === 'MergeRequest' ? 'mr' : undefined
  if (!kind) return
  const note = comment.parse(event.object_attributes)
  if (note.system || note.author_id === account.userId || (note.action && !['create', 'update'].includes(note.action))) return
  const target = parent.parse((raw as Record<string, unknown>)[kind === 'issue' ? 'issue' : 'merge_request'])
  if ((note.noteable_id != null && note.noteable_id !== target.id) ||
      (target.target_project_id !== undefined && target.target_project_id !== account.projectId)) return
  return { kind, iid: target.iid, receivedAt, note: {
    id: note.id, discussionId: /^[a-zA-Z0-9_-]{1,128}$/.test(note.discussion_id ?? '') ? note.discussion_id! : undefined,
    edit: note.action === 'update',
    mentioned: note.note === undefined || gitlabMention(note.note, account.username),
    agentMerge: kind === 'mr' && target.author_id === account.userId,
  } }
}

interface WebhookHost {
  readonly store: Store
  readonly effects: Effects
  readonly machine: { stateDir: string }
  readonly lifetime: AbortSignal
  context(kind: typeof gitlabKind): SourceContext
}
function reply(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'cache-control': 'no-store' })
  res.end()
}
function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return typeof value === 'string' ? value : undefined
}

function readToken(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error('must be a regular file')
    const mode = stat.mode & 0o7777
    if (mode !== 0o600 && mode !== 0o400) throw new Error(`mode ${mode.toString(8).padStart(4, '0')} is invalid; use 0600 or 0400`)
    // Allow a trailing line ending, but never read an unbounded file.
    const bytes = Buffer.alloc(515)
    if (stat.size >= bytes.length) throw new Error('must contain 1–512 bytes of token text')
    const length = readSync(fd, bytes, 0, bytes.length, 0)
    const token = bytes.toString('utf8', 0, length).trim()
    if (length >= bytes.length || !token || Buffer.byteLength(token) > 512) throw new Error('must contain 1–512 bytes of token text')
    return token
  } finally { closeSync(fd) }
}

/** Mount the receiver on the existing loopback listener. Only this path needs an HTTPS reverse proxy. */
export function registerGitlabWebhook(ctx: Context, host: WebhookHost, health: HealthEntry): () => void {
  const { store, effects, lifetime } = host
  const source = () => host.context(gitlabKind)
  const enabled = (source: SourceContext) => !lifetime.aborted && source.configured() && !!source.config<GitlabConfig>('gitlab')?.webhookEnabled
  effects.handle('gitlabWebhook', event => processGitlabHook(source(), event, lifetime), {
    limit: () => {
      const current = source()
      return enabled(current) && !gitlabCoolingDown(current.commands) ? 1 : 0
    }, retry: [5000, 300_000],
  })
  const tokenPath = join(host.machine.stateDir, 'gitlab-webhook-token')
  function refreshHealth() {
    const current = source()
    if (!enabled(current)) {
      health.set({ state: 'paused', detail: 'GitLab webhook intake is off or setup is incomplete' })
      return
    }
    try { readToken(tokenPath) } catch (error) {
      const detail = (error as NodeJS.ErrnoException).code ? 'create a readable file with mode 0600 or 0400' : (error as Error).message
      health.set({ state: 'error', detail: `gitlab-webhook-token: ${detail}` })
      return
    }
    try {
      const last = store.db.prepare('SELECT MAX(received) AS received FROM gitlab_hook_receipt WHERE received >= ?')
        .get(Date.now() - RETENTION)?.received
      health.set(last == null
        ? { state: 'starting', detail: 'No recorded GitLab webhook delivery in the past 14 days. Send a test event.' }
        : { state: 'ready', detail: `Last recorded GitLab webhook delivery: ${new Date(Number(last)).toISOString()}` })
    } catch {
      health.set({ state: 'error', detail: 'Unable to read GitLab webhook delivery receipts' })
    }
  }
  let pruneAt = 0
  const unregister = ctx.webServer.register({ kind: 'prefix', path: PATH, handler: async (req, res) => {
    if (req.url !== PATH) return reply(res, 404)
    if (req.method !== 'POST') return reply(res, 405)
    const current = source()
    if (lifetime.aborted || !current.configured()) return reply(res, 503)
    const account = current.deployment.gitlab
    if (!account || !enabled(current)) return reply(res, 404)
    const token = header(req, 'x-gitlab-token')
    if (!token || token.length > 512) return reply(res, 401)
    let expected: string
    try { expected = readToken(tokenPath) } catch { return reply(res, 503) }
    const providedBytes = Buffer.from(token), expectedBytes = Buffer.from(expected)
    if (providedBytes.length !== expectedBytes.length || !timingSafeEqual(providedBytes, expectedBytes)) return reply(res, 401)
    const instance = header(req, 'x-gitlab-instance')
    if (instance && instance.replace(/\/$/, '') !== account.baseUrl) return reply(res, 403)
    if (header(req, 'content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return reply(res, 415)
    if (Number(header(req, 'content-length')) > MAX_BYTES) return reply(res, 413)

    const chunks: Buffer[] = []
    let size = 0, event: GitlabHookEvent | undefined, raw: string
    const now = Date.now()
    try {
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        const bytes = Buffer.from(chunk)
        size += bytes.length
        if (size > MAX_BYTES) return reply(res, 413)
        chunks.push(bytes)
      }
      raw = Buffer.concat(chunks).toString('utf8')
      event = normalize(JSON.parse(raw), account, new Date(now).toISOString())
    } catch { return reply(res, 400) }
    if (!event) return reply(res, 204)
    if (!enabled(current)) return reply(res, 503)
    const delivery = header(req, 'webhook-id') || header(req, 'idempotency-key')
    const receipt = key('gitlab-hook', account.baseUrl, String(account.projectId), delivery && delivery.length <= 256 ? delivery : key(raw))
    try {
      const recorded = store.atomic(() => {
        if (now >= pruneAt) store.db.prepare('DELETE FROM gitlab_hook_receipt WHERE received < ?').run(now - RETENTION)
        const inserted = store.db.prepare('INSERT OR IGNORE INTO gitlab_hook_receipt (id, received) VALUES (?, ?)').run(receipt, now)
        if (inserted.changes && !effects.pending('gitlabWebhook', receipt)) effects.enqueue('gitlabWebhook', receipt, event)
        return inserted.changes > 0
      })
      if (now >= pruneAt) pruneAt = now + DAY
      if (recorded) refreshHealth()
    } catch { return reply(res, 503) }
    reply(res, 200)
  } })
  refreshHealth()
  const timer = setInterval(refreshHealth, 30_000).unref()
  return () => { clearInterval(timer); unregister(); health.release() }
}

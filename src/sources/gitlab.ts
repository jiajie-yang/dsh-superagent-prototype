/** Single-project GitLab Source with polling and webhook-driven intake. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { gitlabUrl } from '../gitlab-deployment.ts'
import { GitlabAccountsSchema } from '../deployment.ts'
import { key, liveTicket, type Trigger } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import type { SourceKind } from './kind.ts'
import { sourceContext, type SourceContext } from './host.ts'
import { pause, polled, cursorAt } from './poll.ts'
import { gitlabCoolingDown, gitlabEventReads, gitlabPages, ObjectSchema, DiscussionSchema, collection, objectPath, readMerge, gitlabThreadContext,
  type GitlabObject, type GitlabReads, type NoteSchema, type ObjectKind } from './gitlab-read.ts'
import { claimMerge, gitlabThread, gitlabWorktree, observeMerge } from './gitlab-merge.ts'
import { sendGitlab } from './gitlab-channel.ts'

export const GitlabConfigSchema = GitlabAccountsSchema.extend({ baseUrl: z.string().trim().refine(value => {
  if (!value) return true
  try { gitlabUrl(value); return true } catch { return false }
}, 'Use an HTTPS GitLab origin without a path or credentials').transform(value => value ? gitlabUrl(value) : '').default(''), pollSeconds: z.number().int().min(30).max(3600).default(60),
  webhookEnabled: z.boolean().default(false), receiveAllIssues: z.boolean().default(false), receiveAllMergeRequests: z.boolean().default(false), receiveAllComments: z.boolean().default(false) }).strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>
const actorId = (instance: string, id: number) => `${encodeURIComponent(instance)}:${id}`
export const gitlabMention = (text: string, username: string): boolean => new RegExp(`(^|[^\\w@])@${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`).test(text)
export function gitlabTrigger(ctx: SourceContext, kind: ObjectKind, object: GitlabObject, input: {
  id: string; text: string; at: string; userId: number; username: string; bot?: boolean; noteId?: number; discussionId?: string; contextOnly?: boolean
}): Trigger | undefined {
  const a = ctx.deployment.gitlab!
  if (input.userId === a.userId) return
  const thread = gitlabThread(a.baseUrl, a.projectId, kind, object.iid)
  const url = object.web_url + (input.noteId ? `#note_${input.noteId}` : '')
  return { id: input.id, source: 'gitlab', threads: [{ source: 'gitlab', id: thread }],
    actor: { source: 'gitlab', id: input.contextOnly ? '' : actorId(a.baseUrl, input.userId) }, human: !input.bot && !ctx.listedBot?.(actorId(a.baseUrl, input.userId)) && !input.contextOnly,
    ...!input.contextOnly && gitlabMention(input.text, a.username) ? { addressed: 'mention' as const } : {}, text: input.text, at: input.at, url,
    channel: { source: 'gitlab', thread: `gitlab:${thread}`, address: { instance: a.baseUrl, projectId: String(a.projectId), objectKind: kind, iid: String(object.iid), url,
      ...input.discussionId ? { discussionId: input.discussionId } : {} } },
    meta: { instance: a.baseUrl, project: ctx.config<GitlabConfig>('gitlab')?.project, projectId: a.projectId, objectKind: kind, iid: object.iid, noteId: input.noteId,
      mentioned: gitlabMention(input.text, a.username), row: input.noteId ? 'comments' : kind === 'mr' ? 'mrs' : 'issues', contextOnly: !!input.contextOnly,
      ...input.discussionId ? { discussionId: input.discussionId } : {} } }
}
/** Commit observed body and Trigger together; async receive adapters are rejected and rolled back. */
export function observeBody(ctx: SourceContext, kind: ObjectKind, object: GitlabObject, since: string, contextOnly = false, confirmedOpen = false): void {
  const a = ctx.deployment.gitlab!
  const id = gitlabThread(a.baseUrl, a.projectId, kind, object.iid), stateKey = KV.gitlab.body(id)
  const text = `${object.title}\n${object.description ?? ''}`, hash = key(text)
  ctx.atomic(() => {
    const old = ctx.state.get(stateKey)
    if (old && Date.parse(object.updated_at) < Date.parse(old.updatedAt)) return
    const emit = (triggerId: string, edit: boolean) => {
      const trigger = gitlabTrigger(ctx, kind, object, { id: triggerId, text,
        at: edit ? object.updated_at : object.created_at, userId: object.author.id, username: object.author.username,
        bot: object.author.bot, contextOnly: edit })
      if (trigger && Date.parse(trigger.at) >= Date.parse(since)) {
        const result = ctx.receive(trigger)
        if (result instanceof Promise) throw new Error('Body observation requires synchronous receive')
      }
    }
    if (confirmedOpen) {
      // A prior context snapshot must not consume the opening. Preserve deduplication with polling's original opening ID.
      const prior = ctx.triggers.get(key('gitlab-body', id, '1'))
      const opening = key('gitlab-body-open', id)
      if ((!prior || prior.meta.contextOnly) && !ctx.triggers.get(opening)) emit(opening, false)
    }
    if (old?.hash === hash) { ctx.state.set(stateKey, { ...old, updatedAt: object.updated_at }); return }
    const revision = (old?.revision ?? 0) + 1
    // Edits lack a trustworthy editor identity: context only, never authorize as the original author.
    if (!confirmedOpen) emit(key('gitlab-body', id, String(revision)), contextOnly || !!old || object.updated_at !== object.created_at)
    ctx.state.set(stateKey, { hash, revision, updatedAt: object.updated_at })
  })
}
async function receiveObject(ctx: SourceContext, kind: ObjectKind, object: GitlabObject, since: string, signal?: AbortSignal, projectScan = false, contextOnly = false): Promise<void> {
  const commands = gitlabEventReads(ctx.commands, signal)
  observeBody(ctx, kind, object, since, contextOnly)
  const discussions = await gitlabPages(commands, DiscussionSchema, `${objectPath(kind, object.iid)}/discussions`)
  for (const d of discussions) for (const note of d.notes) {
    signal?.throwIfAborted()
    if (!ctx.config('gitlab')) throw new Error('GitLab poll stopped')
    if (note.system || Date.parse(note.updated_at) < Date.parse(since)) continue
    await receiveNote(ctx, kind, object, note, d.id, projectScan)
  }
}
async function receiveNote(ctx: SourceContext, kind: ObjectKind, object: GitlabObject, note: z.infer<typeof NoteSchema>, discussionId: string, projectScan: boolean, edit = false) {
  const a = ctx.deployment.gitlab!
  const trigger = gitlabTrigger(ctx, kind, object, { id: key('gitlab-note', a.baseUrl, String(a.projectId), kind, String(note.id), note.updated_at, key(note.body)),
    text: note.body, at: note.updated_at, userId: note.author.id, username: note.author.username, bot: note.author.bot,
    contextOnly: edit || note.updated_at !== note.created_at, noteId: note.id, discussionId })
  if (trigger) await ctx.receive({ ...trigger, meta: { ...trigger.meta, projectScan } })
}
const boundMerge = (ctx: SourceContext, id: string) => ctx.tickets.open().some(t => t.follows?.some(f => !f.closed && f.thread === `gitlab:${id}`))
async function refreshMergeLifecycle(ctx: SourceContext, commands: GitlabReads, iid: number, active: () => void) {
  const latest = await readMerge(commands, iid)
  active()
  const projectId = ctx.deployment.gitlab!.projectId
  if (latest.iid === iid && latest.source_project_id === projectId && latest.target_project_id === projectId) observeMerge(ctx, latest)
}
function describeObject(ctx: SourceContext, id: string, kind: ObjectKind, object: GitlabObject) {
  ctx.threads.describe(`gitlab:${id}`, { label: `${kind === 'mr' ? '!' : '#'}${object.iid} ${object.title}`, url: object.web_url })
}

/** Only validated routing hints enter the durable queue. Author, text and current state are read with the agent's API access. */
export interface GitlabHookEvent {
  kind: ObjectKind
  iid: number
  receivedAt: string
  deliveryId?: string
  contextOnly?: true
  openHash?: string
  note?: { id: number; discussionId?: string; edit: boolean; mentioned: boolean; agentMerge: boolean }
}

/** Match GitLab's Webhook rendering of simple relative Markdown image URLs against the REST description. */
function webhookDescription(text: string, origin: string, projectId: number): string {
  const lines = text.split('\n')
  const fence = /^``` *$/, htmlEnd = /^<\/[^>]+> *$/
  const lastFence = lines.findLastIndex(line => fence.test(line)), lastHtmlEnd = lines.findLastIndex(line => htmlEnd.test(line))
  let blockEnd: RegExp | undefined
  return lines.map((line, index) => {
    if (blockEnd) {
      if (blockEnd.test(line)) blockEnd = undefined
      return line
    }
    if (index < lastFence && line.startsWith('```')) blockEnd = fence
    else if (index < lastHtmlEnd && /^<[^>]+> *$/.test(line)) blockEnd = htmlEnd
    if (blockEnd) return line
    // GitLab takes the first ]( and the first closing parenthesis after a nonempty destination.
    const parts: string[] = []
    let offset = 0
    for (let image = line.indexOf('![', offset); image !== -1; image = line.indexOf('![', offset)) {
      const destination = line.indexOf('](', image + 2)
      if (destination === -1) break
      const end = line.indexOf(')', destination + 3)
      if (end === -1) break
      const url = line.slice(destination + 2, end)
      const relative = url.replace(/^\//, '')
      const path = relative.startsWith('uploads') ? `/-/project/${projectId}/${relative}` : `/${relative}`
      parts.push(line.slice(offset, destination + 2), /^(https?:)?\/\//.test(url) ? url : origin + path, ')')
      offset = end + 1
    }
    return parts.length ? parts.join('') + line.slice(offset) : line
  }).join('\n')
}

export async function processGitlabHook(ctx: SourceContext, event: GitlabHookEvent, activatedAt: string, signal: AbortSignal): Promise<void> {
  const config = ctx.config<GitlabConfig>('gitlab'), a = ctx.deployment.gitlab
  if (!config?.webhookEnabled || !a) throw new Error('GitLab webhook intake is off')
  const { kind, iid, note } = event
  const id = gitlabThread(a.baseUrl, a.projectId, kind, iid), thread = `gitlab:${id}`
  const subscribed = () => {
    const known = ctx.threads.get(thread)
    return boundMerge(ctx, id) || (!!known?.subscriptions.length && polled(ctx, known))
  }
  if (note && !note.mentioned && !note.agentMerge && !config.receiveAllComments && !subscribed()) return
  const commands = gitlabEventReads(ctx.commands, signal), path = objectPath(kind, iid)
  const active = () => {
    signal.throwIfAborted()
    if (!ctx.config<GitlabConfig>('gitlab')?.webhookEnabled) throw new Error('GitLab webhook intake is off')
  }
  const object = kind === 'mr' ? await readMerge(commands, iid) : ObjectSchema.parse(await commands.gitlab(path))
  active()
  if (object.iid !== iid) throw new Error('GitLab returned a different object')
  if (kind === 'issue' && object.project_id !== undefined && object.project_id !== a.projectId) return
  if (kind === 'mr' && (object.source_project_id !== a.projectId || object.target_project_id !== a.projectId)) return
  if (kind === 'mr' && object.state === 'opened') observeMerge(ctx, object)
  if (note) {
    const discussion = await findHookDiscussion(ctx, commands, path, note.id, note.discussionId)
    active()
    const entry = discussion.notes.find(item => item.id === note.id)!
    if (!entry.system) {
      const historical = Date.parse(entry.created_at) < Date.parse(activatedAt)
      await receiveNote(ctx, kind, object, entry, discussion.id, !subscribed(), note.edit || historical)
    }
  } else {
    const savedBaseline = ctx.state.get(KV.gitlab.baseline)
    const baseline = savedBaseline && savedBaseline <= event.receivedAt ? savedBaseline : cursorAt(event.receivedAt)
    if (kind === 'mr' && object.state !== 'opened' && boundMerge(ctx, id)) {
      // A terminal delivery can arrive before a review comment. Read that MR's unseen discussions before closing its ticket.
      await receiveObject(ctx, kind, object, ctx.state.get(KV.gitlab.cursor(id)) ?? ctx.threads.get(thread)?.createdAt ?? baseline, signal, false, true)
      await refreshMergeLifecycle(ctx, commands, iid, active)
    } else {
      const description = object.description ?? ''
      const author = String(object.author.id)
      const confirmed = !event.contextOnly && object.state === 'opened' && (event.openHash === undefined
        ? object.created_at === object.updated_at
        : event.openHash === key(author, object.title, description)
          || event.openHash === key(author, object.title, webhookDescription(description, a.baseUrl, a.projectId)))
      // GitLab's test button can synthesize an open event from an existing object.
      observeBody(ctx, kind, object, confirmed ? activatedAt : baseline, !confirmed, confirmed)
    }
  }
  describeObject(ctx, id, kind, object)
}
// Cache routing only. Every note's current content and author still come from a fresh API read.
const discussionHints = new WeakMap<SourceContext['commands'], Map<string, string>>()
async function findHookDiscussion(ctx: SourceContext, commands: GitlabReads, path: string, noteId: number, hint?: string) {
  let hints = discussionHints.get(ctx.commands)
  if (!hints) { hints = new Map(); discussionHints.set(ctx.commands, hints) }
  const remember = (discussion: z.infer<typeof DiscussionSchema>) => {
    for (const note of discussion.notes) hints.set(`${path}/${note.id}`, discussion.id)
    while (hints.size > 4096) hints.delete(hints.keys().next().value!)
  }
  const cacheKey = `${path}/${noteId}`, discussionId = hint ?? hints.get(cacheKey)
  if (discussionId) {
    try {
      const discussion = DiscussionSchema.parse(await commands.gitlab(`${path}/discussions/${discussionId}`))
      remember(discussion)
      if (discussion.notes.some(note => note.id === noteId)) return discussion
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== 404) throw error
    }
    hints.delete(cacheKey)
  }
  for (let page = 1; page <= 10000; page++) {
    const list = z.array(DiscussionSchema).parse(await commands.gitlab(`${path}/discussions?per_page=100&page=${page}`))
    for (const discussion of list) remember(discussion)
    const found = list.find(discussion => discussion.notes.some(note => note.id === noteId))
    if (found) return found
    if (list.length < 100) break
  }
  await commands.gitlab(`${path}/notes/${noteId}`)
  throw new Error('The GitLab note exists but its discussion is not available yet')
}
async function observeCi(ctx: SourceContext, object: GitlabObject): Promise<void> {
  const a = ctx.deployment.gitlab!, p = object.head_pipeline
  const id = gitlabThread(a.baseUrl, a.projectId, 'mr', object.iid), stateKey = KV.gitlab.ci(id)
  const old = ctx.state.get(stateKey)
  if (!p) {
    // A later first pipeline is a change too; keep an existing observation across temporary absences.
    if (!old) ctx.state.set(stateKey, { fingerprint: 'no-pipeline', revision: 0 })
    return
  }
  const fingerprint = key(String(p.id), p.sha, p.status, object.sha ?? '')
  if (old?.fingerprint === fingerprint) return
  const revision = (old?.revision ?? 0) + 1
  if (old) await ctx.receive({ id: key('gitlab-ci', id, String(revision), fingerprint), source: 'gitlab', threads: [{ source: 'gitlab', id }],
    actor: { source: 'gitlab', id: '' }, human: false, text: `MR !${object.iid} head ${object.sha ?? 'unknown'}; pipeline ${p.id}: ${p.status} (${p.sha}); current-head association: ${object.sha === p.sha ? 'matching SHA' : 'unverified (merged-results or stale pipeline)'}`,
    at: p.updated_at ?? new Date().toISOString(), meta: { instance: a.baseUrl, project: ctx.config<GitlabConfig>('gitlab')?.project, projectId: a.projectId, objectKind: 'mr', iid: object.iid, ci: true, headSha: object.sha, pipelineSha: p.sha, pipelineId: p.id, pipelineStatus: p.status, headAssociation: object.sha === p.sha ? 'matching_sha' : 'unverified' } })
  ctx.state.set(stateKey, { fingerprint, revision })
}
export async function pollGitlab(ctx: SourceContext, signal?: AbortSignal): Promise<void> {
  const a = ctx.deployment.gitlab
  const config = ctx.config<GitlabConfig>('gitlab')
  if (!a || !config || gitlabCoolingDown(ctx.commands)) return
  const started = new Date().toISOString()
  const since = ctx.state.get(KV.gitlab.since) ?? started
  if (!ctx.state.get(KV.gitlab.since)) ctx.state.set(KV.gitlab.since, since)
  const baseline = ctx.state.get(KV.gitlab.baseline) ?? since
  if (!ctx.state.get(KV.gitlab.baseline)) ctx.state.set(KV.gitlab.baseline, baseline)
  const commands = gitlabEventReads(ctx.commands, signal)
  const visited = new Set<string>()
  const errors: unknown[] = []
  let completed = 0
  const active = () => {
    signal?.throwIfAborted()
    const current = ctx.config<GitlabConfig>('gitlab')
    if (!current || current.webhookEnabled !== config.webhookEnabled) throw new Error('GitLab poll stopped')
  }
  const failed = (error: unknown, id?: string) => {
    active()
    errors.push(error)
    if (id) ctx.threads.patch(`gitlab:${id}`, { pollError: String(error).slice(0, 300) })
    if (error instanceof CliError && error.code === 429) throw error
  }
  const attempt = async (work: () => Promise<void>, id?: string) => {
    try { active(); await work(); active(); completed++ } catch (error) { failed(error, id) }
  }
  const bound = (id: string) => boundMerge(ctx, id)
  const process = async (kind: ObjectKind, object: GitlabObject, projectScan = true) => {
    active()
    const id = gitlabThread(a.baseUrl, a.projectId, kind, object.iid)
    if (visited.has(id)) return
    visited.add(id)
    if (kind === 'mr' && object.source_project_id !== a.projectId) {
      const rejected = gitlabTrigger(ctx, kind, object, { id: key('gitlab-fork', id, object.updated_at), text: object.title, at: object.updated_at,
        userId: object.author.id, username: object.author.username, bot: object.author.bot })
      if (rejected) await ctx.receive({ ...rejected, meta: { ...rejected.meta, fork: true } })
      return
    }
    const openedMerge = kind === 'mr' && object.state === 'opened'
    // Establish ownership before intake so the first discussion reaches its Ticket.
    if (openedMerge) observeMerge(ctx, object)
    // Intake precedes closure. A discussion failure must not hide validated lifecycle state.
    try {
      await receiveObject(ctx, kind, object, ctx.state.get(KV.gitlab.cursor(id)) ?? baseline, signal, projectScan && !(openedMerge && bound(id)))
    } catch (error) {
      active()
      if (kind === 'mr' && !openedMerge && !config.webhookEnabled) observeMerge(ctx, object)
      throw error
    }
    active()
    if (kind === 'mr') {
      if (!openedMerge) {
        if (!config.webhookEnabled) observeMerge(ctx, object)
        else if (bound(id)) await refreshMergeLifecycle(ctx, commands, object.iid, active)
      }
      if (openedMerge && bound(id)) await observeCi(ctx, object)
    }
    ctx.state.set(KV.gitlab.cursor(id), cursorAt(started))
    ctx.threads.patch(`gitlab:${id}`, { pollError: undefined })
    describeObject(ctx, id, kind, object)
  }
  // Priority to existing subscriptions. Closed tickets retain the shared two-week window.
  for (const thread of ctx.threads.subscribed('gitlab')) {
    if (config.webhookEnabled ? !thread.subscriptions.some(id => {
      const ticket = ctx.tickets.get(id)
      return ticket && liveTicket(ticket)
    }) : !polled(ctx, thread)) continue
    const match = /:(issue|mr):(\d+)$/.exec(thread.ref.id)
    if (!match) continue
    const kind = match[1] as ObjectKind, iid = Number(match[2])
    await attempt(async () => process(kind, kind === 'mr' ? await readMerge(commands, iid) : ObjectSchema.parse(await commands.gitlab(objectPath(kind, iid))), false), thread.ref.id)
  }
  // Read all object pages, then discussions: note updates need not advance the parent's updated_at.
  // This deliberately avoids relying on parent updated_after as an undocumented comment cursor.
  if (!config.webhookEnabled) for (const kind of ['issue', 'mr'] as const) {
    await attempt(async () => {
      const objects = await gitlabPages(commands, ObjectSchema, `${collection(kind)}?state=all&order_by=updated_at&sort=asc`, error => failed(error))
      for (const object of objects) {
        await attempt(async () => process(kind, kind === 'mr' ? await readMerge(commands, object.iid) : object), gitlabThread(a.baseUrl, a.projectId, kind, object.iid))
      }
    })
  }
  if (errors.length && !completed) throw errors[0]
  if (!errors.length) ctx.state.set(KV.gitlab.since, cursorAt(started))
  ctx.report('gitlab', { state: errors.length ? 'error' : 'ready', detail: errors.length ? `${errors.length} GitLab reads failed; healthy objects continue polling`
    : config.webhookEnabled ? 'GitLab webhook mode; active subscriptions reconciled' : 'GitLab project and subscriptions polled', at: started })
}
export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: 'gitlab', title: { zh: 'GitLab', en: 'GitLab' }, description: { zh: '单项目 Issue、MR 与评审讨论；大项目的全量讨论轮询成本较高。', en: 'Single-project issues, MRs and discussions; full discussion scans can be expensive on large projects.' },
  schema: GitlabConfigSchema, health: ['gitlab'],
  fields: [
    ...(['baseUrl', 'project', 'cli'] as const).map(field => ({ key: field, type: 'text' as const, label: { zh: field === 'cli' ? '专用 glab 包装器' : field === 'project' ? '项目路径' : 'HTTPS 实例地址', en: field },
      hint: field === 'baseUrl' ? { zh: '例如 https://gitlab.example.com，不含项目路径或 /api/v4。', en: 'For example https://gitlab.example.com, without a project path or /api/v4.' }
        : field === 'project' ? { zh: '例如 group/subgroup/repository，填写项目路径，不是完整 URL。', en: 'For example group/subgroup/repository: a project path, not a full URL.' }
          : { zh: '实例专用 glab 包装器的绝对路径；包装器读取该实例的私有令牌文件，不在此填写令牌。配置步骤见部署文档。', en: 'Absolute path to this instance\'s glab wrapper, which reads its private token file. Do not enter a token here. See the deployment guide.' } })),
    { key: 'pollSeconds', type: 'number', min: 30, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Poll seconds' }, advanced: true },
    { key: 'webhookEnabled', type: 'switch', label: { zh: 'Webhook 接入', en: 'Webhook intake' },
      hint: { zh: '项目较大或 API 配额紧张时启用。先准备密钥和 HTTPS 代理，再启用接收器，最后在 GitLab 创建项目 Webhook。关闭时使用全项目轮询。', en: 'Enable for large projects or tight API quotas. Prepare the secret and HTTPS proxy, enable the receiver here, then create the project hook in GitLab. Turning this off uses project-wide polling.' } },
    ...(['receiveAllIssues', 'receiveAllMergeRequests', 'receiveAllComments'] as const).map(field => ({ key: field, type: 'switch' as const, label: { zh: field === 'receiveAllIssues' ? '接收全部 Issue' : field === 'receiveAllMergeRequests' ? '接收全部 MR' : '接收全部评论', en: field } })),
  ],
  scope: ({ meta }, config) => {
    if (!config.baseUrl || !config.project || meta.project !== config.project || meta.instance !== config.baseUrl.replace(/\/$/, '')) return { listened: false, reason: 'gitlab_outside_instance' }
    if (meta.fork) return { listened: false, reason: 'gitlab_fork_unsupported' }
    if (meta.projectScan && !meta.mentioned && !config.receiveAllComments) return { listened: false, reason: 'gitlab_no_mention' }
    const observed = !meta.ci && !meta.contextOnly && (meta.row === 'issues' ? config.receiveAllIssues : meta.row === 'mrs' ? config.receiveAllMergeRequests : config.receiveAllComments)
    return { listened: true, observed: !!observed, row: String(meta.row ?? 'context') }
  },
  channel: { send: sendGitlab, allowed: (address, config) => address.instance === config.baseUrl.replace(/\/$/, ''),
    link: address => ({ url: address.url ?? '', label: { zh: `GitLab ${address.objectKind === 'mr' ? '!' : '#'}${address.iid}`, en: `GitLab ${address.iid}` } }) },
  threadContext: gitlabThreadContext,
  find: query => ({ threads: [], terms: [query.trim()] }),
  policy: { schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1), name: z.string().optional() })).default([]), bots: z.array(z.object({ id: z.string().min(1), name: z.string().optional() })).optional() }).strict(),
    fields: ['allowed', 'bots'].map(field => ({ key: field, type: 'rows' as const, label: { zh: field === 'allowed' ? '能发起工作的用户' : '候选机器人', en: field },
      hint: field === 'allowed'
        ? { zh: '使用发起任务的人的数字用户 ID 生成完整身份 ID，不要填写智能体账号、用户名或裸数字。格式：encodeURIComponent(实例地址):用户数字 ID，例如 https%3A%2F%2Fgitlab.example.com:123；实例须与 Source 一致。名字仅用于显示，不参与授权。获取与生成命令见部署文档的 GitLab 章节。',
          en: 'Enter the full identity ID built from the requesting person\'s numeric user ID, not the agent account, a username or a bare number. Format: encodeURIComponent(instance URL):numeric user ID, for example https%3A%2F%2Fgitlab.example.com:123; use the Source\'s instance. Names are for display only, not authorization. See the GitLab deployment guide for lookup and generation commands.' }
        : { zh: '这里只添加消息可以成为推断候选的其他机器人，不能发起明确任务。使用与白名单相同的实例编码和数字 ID 格式；名字仅用于显示。',
          en: 'List other bots whose messages may become inferred candidates; they cannot make explicit requests. Use the same encoded-instance and numeric-ID format as the allowed list. Names are for display only.' }, columns: [
      { key: 'id', type: 'text' as const, label: { zh: '编码后的实例:user_id', en: 'Encoded instance:user_id' } }, { key: 'name', type: 'text' as const, label: { zh: '名字', en: 'Name' }, optional: true }] })),
    explicit: { zh: '白名单用户 @ 专用账号；ID 格式为 encodeURIComponent(实例地址):用户数字 ID。', en: 'An allowed user mentions the agent. ID: encodeURIComponent(instance URL):numeric user ID.' },
    rows: stored => { const c = GitlabConfigSchema.parse(stored); return [
      ['issues', 'Issue', c.receiveAllIssues], ['mrs', 'MR', c.receiveAllMergeRequests], ['comments', '评论 / Comments', c.receiveAllComments],
    ].map(([id, label, all]) => ({ id: String(id), label: String(label), note: { zh: all ? '全部消息' : '仅 @', en: all ? 'All' : 'Mentions' }, cells: { listedUnaddressed: !!all, unlistedAddressed: true, unlistedUnaddressed: !!all } })) },
  },
  environment: { variables: [
    ...['URL', 'PROJECT', 'AGENT', 'COMMIT_EMAIL'].map(name => ({ key: `DSH_SUPERAGENT_GITLAB_${name}`, description: { zh: `当前 GitLab ${name}`, en: `GitLab ${name}` } })),
    { key: 'DSH_SUPERAGENT_GITLAB_PROJECT_ID', description: { zh: '已绑定的 GitLab 项目数字 ID', en: 'Bound numeric GitLab project ID' } },
    { key: 'DSH_SUPERAGENT_GITLAB_WORKTREE_MODE', description: { zh: '工作树准备模式：base、mr、resume 或 unknown', en: 'Worktree preparation mode: base, mr, resume, or unknown' } },
    { key: 'DSH_SUPERAGENT_GITLAB_ORIGIN_MR_IID', description: { zh: '工单来源 MR 的项目内编号', en: 'Project-local IID of the ticket origin MR' } },
  ], values: ({ deployment, ticket, trigger }) => {
    const account = deployment.gitlab
    const worktree = account && ticket ? gitlabWorktree(account, ticket, trigger) : undefined
    return { DSH_SUPERAGENT_GITLAB_URL: account?.baseUrl ?? '', DSH_SUPERAGENT_GITLAB_PROJECT: account?.project ?? '',
      DSH_SUPERAGENT_GITLAB_AGENT: account?.username ?? '', DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: account?.email ?? '',
      DSH_SUPERAGENT_GITLAB_PROJECT_ID: String(account?.projectId ?? ''), DSH_SUPERAGENT_GITLAB_WORKTREE_MODE: worktree?.mode ?? '',
      DSH_SUPERAGENT_GITLAB_ORIGIN_MR_IID: worktree?.mrIid ?? '' }
  } },
  facts: (deployment): Record<string, string | { zh: string; en: string }> => deployment?.gitlab ? { cli: { zh: `当前账号 @${deployment.gitlab.username}；项目 ${deployment.gitlab.projectId}`, en: `Agent @${deployment.gitlab.username}; project ${deployment.gitlab.projectId}` } } : {},
}
/** Bind authorization to the resolved numeric project, keeping stored path labels rename-safe. */
export function boundGitlabKind(account: () => SourceContext['deployment']['gitlab'] | undefined): SourceKind<GitlabConfig> {
  return { ...gitlabKind, scope: (trigger, config) => {
    const a = account()
    if (!a || trigger.meta.projectId !== a.projectId || trigger.meta.instance !== a.baseUrl) return { listened: false, reason: 'gitlab_outside_instance' }
    return gitlabKind.scope!({ ...trigger, meta: { ...trigger.meta, project: config.project } }, config)
  } }
}
export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(boundGitlabKind(() => {
    const host = sourceContext(ctx.orchestrator, gitlabKind)
    return host.configured() ? host.deployment.gitlab : undefined
  })), 'gitlab: source kind')
  ctx.effect(() => {
    const stop = new AbortController(), host = sourceContext(ctx.orchestrator, gitlabKind)
    const run = async () => {
      await host.ready
      if (!host.configured() || !host.deployment.gitlab) { host.report('gitlab', { state: 'paused', detail: 'GitLab is not selected or setup is incomplete' }); return }
      let failures = 0
      while (!stop.signal.aborted) {
        const config = host.config<GitlabConfig>('gitlab')
        try {
          if (config) { await pollGitlab(host, stop.signal); failures = 0 }
          else host.report('gitlab', { state: 'paused', detail: 'Source is off' })
        } catch { if (++failures >= 3 && !stop.signal.aborted) host.report('gitlab', { state: 'error', detail: 'GitLab reads failed repeatedly; check account, access and connectivity' }) }
        const seconds = Math.max(config?.webhookEnabled ? 900 : 30, config?.pollSeconds ?? 60)
        await pause(Math.min(3600, seconds * 2 ** Math.min(failures, 5)) * 1000, stop.signal)
      }
    }
    const running = run()
    return async () => { stop.abort(); await running }
  })
}

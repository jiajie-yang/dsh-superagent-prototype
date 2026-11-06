/** Single-project GitLab Source. Full paginated discovery favors correctness over API volume. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { gitlabUrl } from '../gitlab-deployment.ts'
import { GitlabAccountsSchema } from '../deployment.ts'
import { key, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { SourceKind } from './kind.ts'
import { sourceContext, type SourceContext } from './host.ts'
import { pause, polled, cursorAt } from './poll.ts'
import { gitlabPages, ObjectSchema, DiscussionSchema, collection, objectPath, readMerge, gitlabThreadContext, type GitlabObject, type ObjectKind } from './gitlab-read.ts'
import { claimMerge, gitlabThread, observeMerge } from './gitlab-merge.ts'
import { sendGitlab } from './gitlab-channel.ts'

export const GitlabConfigSchema = GitlabAccountsSchema.extend({ baseUrl: z.string().trim().refine(value => {
  if (!value) return true
  try { gitlabUrl(value); return true } catch { return false }
}, 'Use an HTTPS GitLab origin without a path or credentials').transform(value => value ? gitlabUrl(value) : '').default(''), pollSeconds: z.number().int().min(30).max(3600).default(60),
  receiveAllIssues: z.boolean().default(false), receiveAllMergeRequests: z.boolean().default(false), receiveAllComments: z.boolean().default(false) }).strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>
const actorId = (instance: string, id: number) => `${encodeURIComponent(instance)}:${id}`
const addressed = (text: string, username: string): boolean => new RegExp(`(^|[^\\w@])@${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`).test(text)
export function gitlabTrigger(ctx: SourceContext, kind: ObjectKind, object: GitlabObject, input: {
  id: string; text: string; at: string; userId: number; username: string; bot?: boolean; noteId?: number; discussionId?: string; contextOnly?: boolean
}): Trigger | undefined {
  const a = ctx.deployment.gitlab!
  if (input.userId === a.userId) return
  const thread = gitlabThread(a.baseUrl, a.projectId, kind, object.iid)
  const url = object.web_url + (input.noteId ? `#note_${input.noteId}` : '')
  return { id: input.id, source: 'gitlab', threads: [{ source: 'gitlab', id: thread }],
    actor: { source: 'gitlab', id: input.contextOnly ? '' : actorId(a.baseUrl, input.userId) }, human: !input.bot && !ctx.listedBot?.(actorId(a.baseUrl, input.userId)) && !input.contextOnly,
    ...!input.contextOnly && addressed(input.text, a.username) ? { addressed: 'mention' as const } : {}, text: input.text, at: input.at, url,
    channel: { source: 'gitlab', thread: `gitlab:${thread}`, address: { instance: a.baseUrl, projectId: String(a.projectId), objectKind: kind, iid: String(object.iid), url,
      ...input.discussionId ? { discussionId: input.discussionId } : {} } },
    meta: { instance: a.baseUrl, project: ctx.config<GitlabConfig>('gitlab')?.project, projectId: a.projectId, objectKind: kind, iid: object.iid, noteId: input.noteId,
      mentioned: addressed(input.text, a.username), row: input.noteId ? 'comments' : kind === 'mr' ? 'mrs' : 'issues', contextOnly: !!input.contextOnly,
      ...input.discussionId ? { discussionId: input.discussionId } : {} } }
}
/** Commit observed body and Trigger together; async receive adapters are rejected and rolled back. */
export function observeBody(ctx: SourceContext, kind: ObjectKind, object: GitlabObject, since: string): void {
  const a = ctx.deployment.gitlab!
  const id = gitlabThread(a.baseUrl, a.projectId, kind, object.iid), stateKey = KV.gitlab.body(id)
  const text = `${object.title}\n${object.description ?? ''}`, hash = key(text)
  ctx.atomic(() => {
    const old = ctx.state.get(stateKey)
    if (old && Date.parse(object.updated_at) < Date.parse(old.updatedAt)) return
    if (old?.hash === hash) { ctx.state.set(stateKey, { ...old, updatedAt: object.updated_at }); return }
    const revision = (old?.revision ?? 0) + 1
    // Edits lack a trustworthy editor identity: context only, never authorize as the original author.
    const edit = !!old || object.updated_at !== object.created_at
    const trigger = gitlabTrigger(ctx, kind, object, { id: key('gitlab-body', id, String(revision)), text,
      at: edit ? object.updated_at : object.created_at, userId: object.author.id, username: object.author.username,
      bot: object.author.bot, contextOnly: edit })
    if (trigger && Date.parse(trigger.at) >= Date.parse(since)) {
      const result = ctx.receive(trigger)
      if (result instanceof Promise) throw new Error('Body observation requires synchronous receive')
    }
    ctx.state.set(stateKey, { hash, revision, updatedAt: object.updated_at })
  })
}
async function receiveObject(ctx: SourceContext, kind: ObjectKind, object: GitlabObject, since: string, signal?: AbortSignal, projectScan = false): Promise<void> {
  const commands = ctx.commands.withSignal(signal)
  observeBody(ctx, kind, object, since)
  const discussions = await gitlabPages(commands, DiscussionSchema, `${objectPath(kind, object.iid)}/discussions`)
  const a = ctx.deployment.gitlab!
  for (const d of discussions) for (const note of d.notes) {
    signal?.throwIfAborted()
    if (!ctx.config('gitlab')) throw new Error('GitLab poll stopped')
    if (note.system || Date.parse(note.updated_at) < Date.parse(since)) continue
    const trigger = gitlabTrigger(ctx, kind, object, { id: key('gitlab-note', a.baseUrl, String(a.projectId), kind, String(note.id), note.updated_at, key(note.body)),
      text: note.body, at: note.updated_at, userId: note.author.id, username: note.author.username, bot: note.author.bot, contextOnly: note.updated_at !== note.created_at,
      noteId: note.id, discussionId: d.id })
    if (trigger) await ctx.receive({ ...trigger, meta: { ...trigger.meta, projectScan } })
  }
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
  if (!a || !ctx.config('gitlab')) return
  const started = new Date().toISOString()
  const since = ctx.state.get(KV.gitlab.since) ?? started
  if (!ctx.state.get(KV.gitlab.since)) ctx.state.set(KV.gitlab.since, since)
  const baseline = ctx.state.get(KV.gitlab.baseline) ?? since
  if (!ctx.state.get(KV.gitlab.baseline)) ctx.state.set(KV.gitlab.baseline, baseline)
  const commands = ctx.commands.withSignal(signal)
  const visited = new Set<string>()
  const errors: unknown[] = []
  let completed = 0
  const active = () => {
    signal?.throwIfAborted()
    if (!ctx.config('gitlab')) throw new Error('GitLab poll stopped')
  }
  const failed = (error: unknown, id?: string) => {
    active()
    errors.push(error)
    if (id) ctx.threads.patch(`gitlab:${id}`, { pollError: String(error).slice(0, 300) })
  }
  const attempt = async (work: () => Promise<void>, id?: string) => {
    try { active(); await work(); active(); completed++ } catch (error) { failed(error, id) }
  }
  const bound = new Set(ctx.tickets.open().flatMap(t => t.follows?.filter(f => !f.closed && f.thread.startsWith('gitlab:')).map(f => f.thread) ?? []))
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
    // Intake precedes closure. A discussion failure must not hide validated lifecycle state.
    try {
      await receiveObject(ctx, kind, object, ctx.state.get(KV.gitlab.cursor(id)) ?? baseline, signal, projectScan)
    } catch (error) {
      active()
      if (kind === 'mr') observeMerge(ctx, object)
      throw error
    }
    active()
    if (kind === 'mr') {
      observeMerge(ctx, object)
      if (bound.has(`gitlab:${id}`) && object.state === 'opened') await observeCi(ctx, object)
    }
    ctx.state.set(KV.gitlab.cursor(id), cursorAt(started))
    ctx.threads.patch(`gitlab:${id}`, { pollError: undefined })
    ctx.threads.describe(`gitlab:${id}`, { label: `${kind === 'mr' ? '!' : '#'}${object.iid} ${object.title}`, url: object.web_url })
  }
  // Priority to existing subscriptions. Closed tickets retain the shared two-week window.
  for (const thread of ctx.threads.subscribed('gitlab').filter(t => polled(ctx, t))) {
    const match = /:(issue|mr):(\d+)$/.exec(thread.ref.id)
    if (!match) continue
    const kind = match[1] as ObjectKind, iid = Number(match[2])
    await attempt(async () => process(kind, kind === 'mr' ? await readMerge(commands, iid) : ObjectSchema.parse(await commands.gitlab(objectPath(kind, iid))), false), thread.ref.id)
  }
  // Read all object pages, then discussions: note updates need not advance the parent's updated_at.
  // This deliberately avoids relying on parent updated_after as an undocumented comment cursor.
  for (const kind of ['issue', 'mr'] as const) {
    await attempt(async () => {
      const objects = await gitlabPages(commands, ObjectSchema, `${collection(kind)}?state=all&order_by=updated_at&sort=asc`, error => failed(error))
      for (const object of objects) {
        await attempt(async () => process(kind, kind === 'mr' ? await readMerge(commands, object.iid) : object), gitlabThread(a.baseUrl, a.projectId, kind, object.iid))
      }
    })
  }
  if (errors.length && !completed) throw errors[0]
  if (!errors.length) ctx.state.set(KV.gitlab.since, cursorAt(started))
  ctx.report('gitlab', { state: errors.length ? 'error' : 'ready', detail: errors.length ? `${errors.length} GitLab reads failed; healthy objects continue polling` : 'GitLab project and subscriptions polled', at: started })
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
  environment: { variables: ['URL', 'PROJECT', 'AGENT', 'COMMIT_EMAIL'].map(name => ({ key: `DSH_SUPERAGENT_GITLAB_${name}`, description: { zh: `当前 GitLab ${name}`, en: `GitLab ${name}` } })),
    values: ({ deployment }) => ({ DSH_SUPERAGENT_GITLAB_URL: deployment.gitlab?.baseUrl ?? '', DSH_SUPERAGENT_GITLAB_PROJECT: deployment.gitlab?.project ?? '', DSH_SUPERAGENT_GITLAB_AGENT: deployment.gitlab?.username ?? '', DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: deployment.gitlab?.email ?? '' }) },
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
        await pause(Math.min(3600, (config?.pollSeconds ?? 60) * 2 ** Math.min(failures, 5)) * 1000, stop.signal)
      }
    }
    const running = run()
    return async () => { stop.abort(); await running }
  })
}

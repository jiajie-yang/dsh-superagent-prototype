/** GitLab source kind definition, polling loop, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import { KV } from '../kv.ts'
import { createGitlabApi, gitlabToken, type GitlabApi } from './gitlab-api.ts'
import { gitlabLink, sendGitlab } from './gitlab-channel.ts'
import { gitlabThreadContext } from './gitlab-read.ts'
import { gitlabThreadId, issueTrigger, mergeRequestTrigger, noteTrigger, SOURCE, type GitlabIssue, type GitlabMergeRequest, type GitlabNote,
  type GitlabRef } from './gitlab-trigger.ts'
import { health, sourceContext, type SourceContext, type Health } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import { cursorAt, pause } from './poll.ts'

/** A project path (`group/subgroup/project`) or an empty value while the Source waits for configuration. */
const PROJECT_PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
/** True for an https instance URL under any path prefix, or http on loopback for a local test instance. */
export function validBaseUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash) return false
    return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname))
  } catch { return false }
}
const BaseUrlSchema = z.string().trim().default('')
  .refine(value => value === '' || validBaseUrl(value), 'An https URL, or http on loopback')
const ProjectSchema = z.string().trim().default('')
  .refine(value => value === '' || (PROJECT_PATH.test(value) && !value.split('/').some(part => part === '.' || part === '..')),
    'A project path such as group/subgroup/project')
export const GitlabConfigSchema = z.object({
  baseUrl: BaseUrlSchema,
  project: ProjectSchema,
  pollSeconds: z.number().int().min(30).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false),
  observeMergeRequests: z.boolean().default(false),
  observeNotes: z.boolean().default(false),
}).strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>
const OBSERVED = { issues: 'observeIssues', merge_requests: 'observeMergeRequests', comments: 'observeNotes' } as const
type Row = keyof typeof OBSERVED
/** The admission row a Trigger belongs to: a note is a comment, otherwise the Issue or merge request itself. */
function rowOf(meta: Record<string, unknown>): Row | undefined {
  if (typeof meta.noteId === 'number') return 'comments'
  return meta.kind === 'issue' ? 'issues' : meta.kind === 'merge_request' ? 'merge_requests' : undefined
}
const USERNAME = /^[A-Za-z0-9_.-]{1,255}$/
export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '企业内网自建 GitLab 实例上的一个项目；接收 Issue、合并请求和评论，按策略决定谁可以发起工作。',
    en: 'One project on a self-hosted GitLab instance; receives Issues, merge requests and notes, and the Policy decides who may originate work.' },
  schema: GitlabConfigSchema,
  fields: [
    { key: 'baseUrl', type: 'text', label: { zh: '实例地址', en: 'Instance URL' },
      hint: { zh: '例如 https://gitlab.example.com 或 https://example.com/gitlab。只接受 https；内网自签证书用 NODE_EXTRA_CA_CERTS 指定 CA，不关闭校验。',
        en: 'For example https://gitlab.example.com or https://example.com/gitlab. Only https is accepted; point NODE_EXTRA_CA_CERTS at an internal CA rather than disabling verification.' } },
    { key: 'project', type: 'text', label: { zh: '项目路径', en: 'Project path' },
      hint: { zh: '写作 group/subgroup/project 的完整路径，不是项目显示名。机器人的 token 必须能读取这个项目；评论需要能创建 Note。',
        en: 'The full path_with_namespace, such as group/subgroup/project, not the display name. The bot token must be able to read the project, and to create notes for replies.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 30, max: 3600,
      label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' },
      hint: { zh: '每轮读取这个项目里更新过的 Issue、合并请求和新评论。自建实例的负载越低，间隔可以越短。',
        en: 'Each round reads the issues and merge requests updated in this project, with their new notes. A quieter self-hosted instance tolerates a shorter interval.' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20,
      label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' },
      hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收项目里的新 Issue', en: 'Receive new Issues in the project' },
      hint: { zh: '打开后，没有 @ 机器人的新 Issue 也会收到，由策略的接收表决定是否成为候选。从打开的时候开始，不读以前的。',
        en: 'New Issues that do not mention the bot are received too, and the Policy admission table decides whether they become candidates. Starts when switched on; earlier ones are not read.' } },
    { key: 'observeMergeRequests', type: 'switch', label: { zh: '接收项目里的新合并请求', en: 'Receive new merge requests in the project' },
      hint: { zh: '打开后，没有 @ 机器人的新合并请求也会收到，由策略的接收表决定是否成为候选。',
        en: 'New merge requests that do not mention the bot are received too, and the Policy admission table decides whether they become candidates.' } },
    { key: 'observeNotes', type: 'switch', label: { zh: '接收项目里的评论', en: 'Receive notes in the project' },
      hint: { zh: '打开后，Issue 和合并请求上没有 @ 机器人的评论也会收到，由策略的接收表决定是否成为候选。工单订阅的线程里的评论总是送达该工单。',
        en: 'Notes on Issues and merge requests that do not mention the bot are received too, and the Policy admission table decides whether they become candidates. Notes on a Thread a Ticket subscribes to always reach that Ticket.' } },
  ],
  health: ['gitlab'],
  scope: ({ meta }, config) => {
    const row = rowOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...(row ? { row } : {}) }
  },
  channel: {
    allowed: (address, config) => address.project === config.project && address.baseUrl === config.baseUrl
      && (address.kind === 'issue' || address.kind === 'merge_request'),
    send: sendGitlab,
    link: gitlabLink,
  },
  threadContext: gitlabThreadContext,
  // `#12` is an Issue and `!12` a merge request, as GitLab writes them; a project page or note link names its Thread too.
  find: query => {
    const text = query.trim()
    const short = /^#(\d+)$/.exec(text)
    if (short?.[1]) return { threads: [`gitlab:issue:${short[1]}`], terms: [] }
    const bang = /^!(\d+)$/.exec(text)
    if (bang?.[1]) return { threads: [`gitlab:mr:${bang[1]}`], terms: [] }
    const named = /^(?:gitlab:)?(issue|mr):(\d+)$/.exec(text)
    if (named?.[1] && named[2]) return { threads: [`gitlab:${named[1]}:${named[2]}`], terms: [] }
    const page = /\/-\/(issues|merge_requests)\/(\d+)\/?(?:#note_\d+)?$/.exec(text)
    return { threads: page?.[1] && page[2] ? [`gitlab:${page[1] === 'issues' ? 'issue' : 'mr'}:${page[2]}`] : [], terms: [] }
  },
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(USERNAME) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(USERNAME) }).strict()).optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitLab 账号', en: 'GitLab accounts that may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]{1,255}' }] },
      { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose notes may become candidates' },
        hint: { zh: '名单里的机器人账号（GitLab 用户对象的 bot 为 true）的评论在来源收到时成为推断的候选，交给评估。它们不能发起明确的请求，也不能停止工单；其他机器人的评论不接收。',
          en: 'A note of a bot account on this list (the GitLab user object reports bot true) becomes an inferred candidate for an assessment when the Source receives it. Such a note never makes an explicit request or stops a ticket; other bots\' notes are not admitted.' },
        columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]{1,255}' }] },
    ],
    explicit: { zh: '名单里的账号在 Issue、合并请求或评论里 @ 机器人的账号。', en: 'An account on the list mentions the bot\'s account in an Issue, a merge request or a note.' },
    rows(stored) {
      const config = GitlabConfigSchema.partial().parse(stored)
      const note = (observed: boolean | undefined): Localized => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: Row, label: Localized) => ({ id, label, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('merge_requests', { zh: '新合并请求', en: 'New merge requests' }),
        row('comments', { zh: '评论（Note）', en: 'Notes' })]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_BASE_URL', description: { zh: '这个来源的 GitLab 实例地址；工单不是从这个来源来的时也可能有值',
        en: 'The GitLab instance this Source watches; it can be set even when the ticket did not start on this Source' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT', description: { zh: '这个来源监听的项目路径，group/subgroup/project',
        en: 'The project path this Source watches, group/subgroup/project' } },
      { key: 'DSH_SUPERAGENT_GITLAB_KIND', description: { zh: '接下工单的是 Issue 还是合并请求：issue 或 merge_request；工单不是从 GitLab 来的时为空',
        en: 'Whether the ticket started in an Issue or a merge request: issue or merge_request; empty when the ticket did not start on GitLab' } },
      { key: 'DSH_SUPERAGENT_GITLAB_NUMBER', description: { zh: '接下工单的 Issue 或合并请求的 IID；工单不是从 GitLab 来的时为空',
        en: 'The IID of the Issue or merge request that started the ticket; empty when the ticket did not start on GitLab' } },
      { key: 'DSH_SUPERAGENT_GITLAB_URL', description: { zh: '接下工单的 Issue、合并请求或评论的网页地址；工单不是从 GitLab 来的时为空',
        en: 'The web page of the Issue, merge request or note that started the ticket; empty when the ticket did not start on GitLab' } },
    ],
    values: ({ config, trigger }) => {
      const fromGitlab = trigger?.source === SOURCE && (trigger.meta.kind === 'issue' || trigger.meta.kind === 'merge_request')
      const iid = fromGitlab ? Number(trigger.meta.iid) || 0 : 0
      return { DSH_SUPERAGENT_GITLAB_BASE_URL: config.baseUrl, DSH_SUPERAGENT_GITLAB_PROJECT: config.project,
        DSH_SUPERAGENT_GITLAB_KIND: fromGitlab ? String(trigger.meta.kind) : '', DSH_SUPERAGENT_GITLAB_NUMBER: iid ? String(iid) : '',
        DSH_SUPERAGENT_GITLAB_URL: fromGitlab ? trigger.url ?? '' : '' }
    },
  },
}
export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    // An unhandled rejection ends the DSH process, so a failure escaping the polling loop becomes the Source's health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('gitlab', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
/** Returns an error health once `failures` consecutive polls fail, or undefined so a single network interruption stays quiet. */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let failures = 0
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then nothing is polled.
  if (!ctx.configured()) { ctx.report('gitlab', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<GitlabConfig>(SOURCE)
    try {
      if (!config) { ctx.report('gitlab', health('paused', 'sourceOff')); failures = 0 }
      else if (!config.baseUrl || !config.project) { ctx.report('gitlab', health('paused', 'gitlabUnconfigured')); failures = 0 }
      else if (!gitlabToken()) { ctx.report('gitlab', health('paused', 'gitlabTokenUnset')); failures = 0 }
      else {
        const counts = await pollRound(ctx, signal)
        failures = 0
        ctx.report('gitlab', { state: 'ready', at: new Date().toISOString(),
          detail: `${counts.issues} new Issues, ${counts.mergeRequests} new merge requests, ${counts.notes} notes` })
      }
    } catch (error) {
      // A Source switched off during a round stops it on purpose; only a real failure counts toward health.
      if (!signal.aborted && ctx.config(SOURCE)) {
        failures += 1
        const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
        if (failed) ctx.report('gitlab', failed)
      }
    }
    await pause(Math.max(config?.pollSeconds ?? 60, 30) * 1000, signal)
  }
}
/** What one polling round took in, by kind. */
export interface GitlabRoundCounts { issues: number; mergeRequests: number; notes: number }
/**
 * Reads the Issues and merge requests updated since the stored cursor, then the notes newer than each Thread's checkpoint.
 * A failed round leaves the project cursor where it was, so the next round reads the same interval again; stable Trigger IDs
 * make that replay harmless.
 */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal, api?: GitlabApi): Promise<GitlabRoundCounts> {
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (!config) return { issues: 0, mergeRequests: 0, notes: 0 }
  const gitlab = api ?? createGitlabApi(config, undefined, signal)
  const started = new Date().toISOString()
  const stored = ctx.state.get(KV.gitlab.since)
  const since = stored ?? started
  if (stored === undefined) ctx.state.set(KV.gitlab.since, since)
  const me = await gitlab.me()
  const counts: GitlabRoundCounts = { issues: 0, mergeRequests: 0, notes: 0 }
  const failures: string[] = []
  const stopped = (): boolean => signal?.aborted === true || !ctx.config(SOURCE)
  const [issues, mergeRequests] = await Promise.allSettled([gitlab.updatedIssues(since), gitlab.updatedMergeRequests(since)])
  if (issues.status === 'rejected') failures.push(`Issues: ${String(issues.reason)}`)
  if (mergeRequests.status === 'rejected') failures.push(`merge requests: ${String(mergeRequests.reason)}`)
  for (const issue of issues.status === 'fulfilled' ? issues.value : []) {
    if (stopped()) throw new Error('The GitLab Source stopped during the poll')
    const ref: GitlabRef = { baseUrl: config.baseUrl, project: config.project, kind: 'issue', iid: issue.iid, url: issue.web_url }
    const thread = `${SOURCE}:${gitlabThreadId('issue', issue.iid)}`
    ctx.threads.describe(thread, { label: `#${issue.iid} ${issue.title}`, url: issue.web_url,
      facts: { number: { value: `#${issue.iid}` } } })
    try {
      if (createdSince(issue, since) && !sameName(issue.author.username, me.username)) {
        await ctx.receive(issueTrigger(issue, ref, me.username))
        counts.issues += 1
      }
      counts.notes += await consumeNotes(ctx, gitlab, me.username, ref, config, since, started, stopped)
      ctx.threads.patch(thread, { pollError: undefined })
    } catch (error) { failed(ctx, failures, thread, error) }
  }
  for (const pull of mergeRequests.status === 'fulfilled' ? mergeRequests.value : []) {
    if (stopped()) throw new Error('The GitLab Source stopped during the poll')
    const ref: GitlabRef = { baseUrl: config.baseUrl, project: config.project, kind: 'merge_request', iid: pull.iid, url: pull.web_url }
    const thread = `${SOURCE}:${gitlabThreadId('merge_request', pull.iid)}`
    ctx.threads.describe(thread, { label: `!${pull.iid} ${pull.title}`, url: pull.web_url,
      facts: { number: { value: `!${pull.iid}` } } })
    try {
      if (createdSince(pull, since) && !sameName(pull.author.username, me.username)) {
        await ctx.receive(mergeRequestTrigger(pull, ref, me.username))
        counts.mergeRequests += 1
      }
      counts.notes += await consumeNotes(ctx, gitlab, me.username, ref, config, since, started, stopped)
      ctx.threads.patch(thread, { pollError: undefined })
    } catch (error) { failed(ctx, failures, thread, error) }
  }
  if (failures.length) throw new Error(`${failures.length} GitLab reads failed: ${failures.slice(0, 3).join('; ')}`)
  ctx.state.set(KV.gitlab.since, cursorAt(started))
  return counts
}
const createdSince = (item: GitlabIssue | GitlabMergeRequest, since: string): boolean =>
  Date.parse(item.created_at) >= Date.parse(since)
/** Records a per-item failure on its Thread and in the round, so other Threads still poll. */
function failed(ctx: SourceContext, failures: string[], thread: string, error: unknown): void {
  failures.push(`${thread}: ${String(error)}`)
  ctx.threads.patch(thread, { pollError: String(error) })
}
/**
 * Reads a Thread's notes after its checkpoint and receives the ones that mention the bot, the Source observes notes, or a Ticket
 * already follows the Thread. The checkpoint moves only after every note of the Thread was stored.
 */
async function consumeNotes(ctx: SourceContext, gitlab: GitlabApi, agent: string, ref: GitlabRef, config: GitlabConfig, since: string,
  started: string, stopped: () => boolean): Promise<number> {
  const thread = `${SOURCE}:${gitlabThreadId(ref.kind, ref.iid)}`
  const checkpoint = ctx.state.get(KV.gitlab.notes(thread)) ?? since
  const notes: GitlabNote[] = await gitlab.notes(ref.kind, ref.iid, checkpoint)
  let received = 0
  for (const note of notes) {
    if (stopped()) throw new Error('The GitLab Source stopped during the poll')
    const trigger: Trigger | undefined = noteTrigger(note, ref, agent)
    if (!trigger) continue
    // An unaddressed note outside a followed Thread is only in scope while the Source observes notes.
    if (!trigger.addressed && !config.observeNotes && !ctx.threads.get(thread)) continue
    await ctx.receive(trigger)
    received += 1
  }
  ctx.state.set(KV.gitlab.notes(thread), cursorAt(started))
  return received
}

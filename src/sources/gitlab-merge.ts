/** MR ownership, lifecycle and model-facing delivery projection. */
import { key, liveTicket, type Ticket, type Thread, type OutboundMessage } from '../core/index.ts'
import { ticketBranch } from './github-pull.ts'
import type { SourceContext } from './host.ts'
import type { GitlabObject } from './gitlab-read.ts'
export function gitlabThread(instance: string, project: number, kind: 'issue' | 'mr', iid: number): string {
  return `${encodeURIComponent(instance)}:${project}:${kind}:${iid}`
}
export function mergeOf(ticket: Pick<Ticket, 'follows'>, thread?: (key: string) => Thread | undefined): { iid: number; url?: string } | undefined {
  const follows = ticket.follows?.filter(f => /^gitlab:.*:mr:\d+$/.test(f.thread)) ?? []
  const follow = follows.findLast(f => !f.closed) ?? follows.at(-1)
  if (!follow) return
  const iid = Number(follow.thread.split(':').at(-1))
  const url = thread?.(follow.thread)?.meta.url
  return { iid, ...(typeof url === 'string' ? { url } : {}) }
}
export function claimMerge(ctx: SourceContext, ticketId: string, mr: GitlabObject): string | undefined {
  const account = ctx.deployment.gitlab
  const ticket = ctx.tickets.get(ticketId)
  if (!account || !ticket || !liveTicket(ticket)) return 'Ticket is no longer active'
  if (mr.target_project_id !== account.projectId || mr.source_project_id !== account.projectId) return 'Fork or foreign project MR is unsupported'
  const ref = { source: 'gitlab', id: gitlabThread(account.baseUrl, account.projectId, 'mr', mr.iid) }
  const thread = `gitlab:${ref.id}`
  const origin = ctx.triggers.get(ticket.origin.triggerId)
  const started = origin?.source === 'gitlab' && origin.threads.some(item => item.id === ref.id)
  const own = mr.author.id === account.userId && ticketBranch(ticket, mr.source_branch ?? '')
  if (!started && !own) return 'MR is not the originating MR or an agent MR on this ticket branch'
  if (ctx.tickets.open().some(t => t.id !== ticketId && t.follows?.some(f => f.thread === thread && !f.closed))) return 'MR belongs to another active ticket'
  if (mr.state === 'opened') {
    ctx.tickets.bindThread(ticketId, ref, own)
    ctx.threads.patch(thread, { iid: mr.iid, objectKind: 'mr', url: mr.web_url })
  }
  return undefined
}
export function observeMerge(ctx: SourceContext, mr: GitlabObject): void {
  const account = ctx.deployment.gitlab!
  const ref = { source: 'gitlab', id: gitlabThread(account.baseUrl, account.projectId, 'mr', mr.iid) }
  if (mr.state === 'merged' || mr.state === 'closed') {
    ctx.tickets.threadClosed(ref, mr.state === 'merged' ? 'merged' : 'closed', mr.merged_at ?? mr.closed_at ?? mr.updated_at)
  } else if (mr.state === 'opened') {
    const candidates = ctx.tickets.open().filter(t => t.follows?.some(f => f.thread === `gitlab:${ref.id}`) ||
      (mr.author.id === account.userId && ticketBranch(t, mr.source_branch ?? '') && !t.follows?.some(f => f.thread.startsWith('gitlab:') && !f.closed && f.thread !== `gitlab:${ref.id}`)))
    if (candidates.length === 1) claimMerge(ctx, candidates[0]!.id, mr)
  }
}
export function mergeEndNotices(ticket: Ticket, request: string, ctx: SourceContext): OutboundMessage[] {
  const follows = ticket.follows?.filter(f => f.closed && /^gitlab:.*:mr:\d+$/.test(f.thread)) ?? []
  const latest = (items: typeof follows) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(f => f.own)) ?? latest(follows)
  const mr = follow ? { iid: Number(follow.thread.split(':').at(-1)) } : undefined
  const outcome = follow?.closed?.outcome, account = ctx.deployment.gitlab
  if (!mr || !account || !['merged', 'closed'].includes(ticket.ended?.outcome ?? '')) return []
  const url = `${account.baseUrl}/${account.project}/-/merge_requests/${mr.iid}`
  const text = /\p{Script=Han}/u.test(request) ? `[MR !${mr.iid}](${url}) ${outcome === 'merged' ? '已合并。' : '已关闭，未合并。'}`
    : `[MR !${mr.iid}](${url}) ${outcome === 'merged' ? 'merged.' : 'closed without merging.'}`
  return ticket.channels.filter(c => c.source !== 'gitlab').map(channel => ({ id: key('gitlab-terminal', account.baseUrl, String(account.projectId), String(mr.iid), outcome!, JSON.stringify(channel)), channel, text, kind: 'notice', ticketId: ticket.id }))
}

/** GitLab outbound channel: posts notes on Issues and merge requests under the bot account. */
import type { OutboundMessage } from '../core/index.ts'
import type { SourceContext } from './host.ts'
import { createGitlabApi, GitlabHttpError, type GitlabApi } from './gitlab-api.ts'
import type { GitlabKind } from './gitlab-trigger.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'

/** The hidden marker that makes a repeated send recognizable; GitLab notes have no idempotency key of their own. */
export const gitlabMarker = (id: string): string => `<!-- dsh-superagent:${id} -->`
const addressKind = (value: string | undefined): GitlabKind | undefined =>
  value === 'issue' || value === 'merge_request' ? value : undefined
/**
 * Posts one note, using the hidden marker to avoid a duplicate after a retry; a 404 means the Issue or merge request is gone.
 * Every other failure throws so the Outbox retries it.
 */
export async function sendNote(api: GitlabApi, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { kind: raw, iid: rawIid } = message.channel.address
  const kind = addressKind(raw)
  const iid = Number(rawIid)
  if (!kind || !Number.isInteger(iid) || iid <= 0) throw new Error('Missing GitLab reply target')
  const marker = gitlabMarker(message.id)
  try {
    if (await api.findNote(kind, iid, marker)) return 'sent'
    await api.postNote(kind, iid, `${message.text}\n\n${marker}`)
    return 'sent'
  } catch (error) {
    if (error instanceof GitlabHttpError && error.status === 404) return 'gone'
    throw error
  }
}
/** The kind's Channel entry; the address carries the instance and project so a queued message can be sent without the saved config. */
export async function sendGitlab(_host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { baseUrl, project } = message.channel.address
  if (!baseUrl || !project) throw new Error('Missing GitLab reply target')
  return sendNote(createGitlabApi({ baseUrl, project }), message)
}
/** The page and label of a reply target; the URL is kept in the address because the web page may be under a path prefix. */
export function gitlabLink(address: Record<string, string>, _links: ChannelLinks): ChannelLink {
  const kind = addressKind(address.kind)
  const iid = address.iid ?? ''
  const project = address.project ?? ''
  const base = (address.baseUrl ?? '').replace(/\/+$/, '')
  const page = kind === 'merge_request' ? 'merge_requests' : 'issues'
  const url = address.url ?? (base && project && iid ? `${base}/${project}/-/${page}/${iid}` : '')
  const label = kind === 'merge_request'
    ? { zh: `GitLab 合并请求 !${iid}`, en: `GitLab merge request !${iid}` }
    : { zh: `GitLab Issue #${iid}`, en: `GitLab issue #${iid}` }
  return { url, label }
}

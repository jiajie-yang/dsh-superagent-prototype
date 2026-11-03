/** Reads a GitLab Issue's or merge request's description and notes for assessments and the panel. */
import type { Trigger } from '../core/index.ts'
import type { ContextMessage, ContextPart, ContextPartName, ThreadContext } from './kind.ts'
import { createGitlabApi, type GitlabApi } from './gitlab-api.ts'
import { gitlabRefOf, type GitlabIssue, type GitlabMergeRequest, type GitlabNote } from './gitlab-trigger.ts'

const rootText = (item: GitlabIssue | GitlabMergeRequest): string => [item.title, item.description ?? ''].filter(Boolean).join('\n\n')
const rootMessage = (item: GitlabIssue | GitlabMergeRequest): ContextMessage => ({
  id: 'root', from: item.author.username, at: item.created_at, text: rootText(item),
  ...(item.author.bot ? { bot: true as const } : {}), ...(item.web_url ? { url: item.web_url } : {}),
})
const noteMessage = (note: GitlabNote): ContextMessage => ({
  id: String(note.id), from: note.author.username, at: note.updated_at ?? note.created_at, text: note.body,
  ...(note.author.bot || note.system ? { bot: true as const } : {}),
})
/** Maps a Trigger to the id its own message has in this context reader; an Issue or merge request body is `root`. */
export const gitlabMessageId = (trigger: Trigger): string => String(trigger.meta.messageId ?? 'root')
/**
 * Reads one page of an Issue's or merge request's notes, its description, or the answered note.
 * GitLab notes do not name the note they answer, so `parent` is empty; replies are ordinary notes in the same Thread.
 */
export async function readGitlabContext(api: GitlabApi, trigger: Trigger, part: ContextPartName, cursor: string | undefined): Promise<ContextPart> {
  const ref = gitlabRefOf(trigger)
  if (!ref) throw new Error('The Trigger is not a GitLab Issue or merge request')
  if (part === 'parent') return { messages: [], body: { messages: [], status: 'no_parent' }, status: 'no_parent' }
  if (part === 'root') {
    const item = ref.kind === 'issue' ? await api.getIssue(ref.iid) : await api.getMergeRequest(ref.iid)
    const message = rootMessage(item)
    return { messages: [message], body: { messages: [message] } }
  }
  const page = cursor === undefined ? 1 : Number(cursor)
  if (!Number.isInteger(page) || page < 1) throw new Error(`A GitLab Thread cursor is a page number, not ${cursor}`)
  const result = await api.notesPage(ref.kind, ref.iid, page)
  const messages = result.items.map(noteMessage)
  return { messages, ...(result.next === undefined ? {} : { next: String(result.next) }), body: { messages } }
}
/** The kind's Thread reader; the Source's configuration supplies the instance and project. */
export const gitlabThreadContext: ThreadContext<{ baseUrl: string; project: string }> = {
  messageId: gitlabMessageId,
  read: async (_commands, trigger, part, cursor, config) => readGitlabContext(createGitlabApi(config), trigger, part, cursor),
}

/** Normalizes GitLab Issues, merge requests and notes into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'gitlab'
/** GitLab serves Issues and merge requests in separate IID sequences, so a Thread names the kind. */
export type GitlabKind = 'issue' | 'merge_request'
export type GitlabIid = { kind: GitlabKind; iid: number }
/** A project-scoped GitLab page; every Trigger and Channel address carries enough of it to be read without the saved config. */
export interface GitlabRef extends GitlabIid { baseUrl: string; project: string; url?: string }
/** The Thread id without the Source prefix: `issue:12` or `mr:12`. */
export const gitlabThreadId = (kind: GitlabKind, iid: number): string => `${kind === 'issue' ? 'issue' : 'mr'}:${iid}`
/** Reply address of an Issue or merge request; `url` is its web page (a note adds its own anchor). */
export const gitlabChannel = (ref: GitlabRef, url?: string): ChannelRef => ({
  source: SOURCE,
  thread: `gitlab:${gitlabThreadId(ref.kind, ref.iid)}`,
  address: { baseUrl: ref.baseUrl, project: ref.project, kind: ref.kind, iid: String(ref.iid), ...(url ? { url } : {}) },
})
/** GitLab renders a deleted account as a missing author; treat it as a sender that can never be on the allowed list. */
export const GitlabUserSchema = z.looseObject({
  id: z.number().int().nonnegative(),
  username: z.string().min(1),
  name: z.string().nullish(),
  bot: z.boolean().default(false),
})
export type GitlabUser = z.infer<typeof GitlabUserSchema>
export const GitlabAuthorSchema = GitlabUserSchema.nullable()
  .transform(user => user ?? { id: 0, username: 'ghost', bot: false } as GitlabUser)
/** An Issue as the Issues API returns it. */
export const GitlabIssueSchema = z.looseObject({
  id: z.number(), iid: z.number().int().positive(), project_id: z.number(), title: z.string(), description: z.string().nullish(),
  state: z.string(), created_at: z.string(), updated_at: z.string(), web_url: z.string(),
  author: GitlabAuthorSchema, confidential: z.boolean().default(false),
})
export type GitlabIssue = z.infer<typeof GitlabIssueSchema>
/** A merge request as the merge requests API returns it. */
export const GitlabMergeRequestSchema = z.looseObject({
  id: z.number(), iid: z.number().int().positive(), project_id: z.number(), title: z.string(), description: z.string().nullish(),
  state: z.string(), created_at: z.string(), updated_at: z.string(), web_url: z.string(),
  author: GitlabAuthorSchema, source_branch: z.string().nullish(), target_branch: z.string().nullish(),
  confidential: z.boolean().default(false),
})
export type GitlabMergeRequest = z.infer<typeof GitlabMergeRequestSchema>
/** An Issue or merge request note; a system note records GitLab's own bookkeeping and never becomes a Trigger. */
export const GitlabNoteSchema = z.looseObject({
  id: z.number().int().positive(), body: z.string(), noteable_type: z.string().nullish(),
  author: GitlabAuthorSchema, created_at: z.string(), updated_at: z.string().nullish(),
  system: z.boolean().default(false), confidential: z.boolean().default(false),
})
export type GitlabNote = z.infer<typeof GitlabNoteSchema>
/** True when `text` mentions `username` as a GitLab user, not as part of a longer word or address. */
export const mentions = (text: string, username: string): boolean =>
  // A trailing period is punctuation, not part of a username, but a dot followed by a username character is.
  new RegExp(`(?:^|[^a-zA-Z0-9_.@-])@${escapeRegExp(username)}(?![a-zA-Z0-9_-]|\\.[a-zA-Z0-9_-])`, 'i').test(text)
const author = (user: GitlabUser, agent: string) =>
  ({ actor: { source: SOURCE, id: user.username }, human: !user.bot && !sameName(user.username, agent) })
const meta = (ref: GitlabRef, messageId: string) =>
  ({ project: ref.project, kind: ref.kind, iid: ref.iid, thread: gitlabThreadId(ref.kind, ref.iid), messageId })
/** Builds the Trigger for a newly opened Issue's title and body. */
export function issueTrigger(issue: GitlabIssue, ref: GitlabRef, agent: string): Trigger {
  const body = issue.description ?? ''
  return { id: key('gitlab-issue', ref.project, String(issue.iid)), source: SOURCE,
    threads: [{ source: SOURCE, id: gitlabThreadId('issue', issue.iid) }], ...author(issue.author, agent), at: issue.created_at,
    text: [issue.title, body].filter(Boolean).join('\n\n'),
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel({ ...ref, kind: 'issue', iid: issue.iid }, issue.web_url), url: issue.web_url,
    meta: meta({ ...ref, kind: 'issue', iid: issue.iid }, 'root') }
}
/** Builds the Trigger for a newly opened merge request's title and description. */
export function mergeRequestTrigger(pull: GitlabMergeRequest, ref: GitlabRef, agent: string): Trigger {
  const body = pull.description ?? ''
  return { id: key('gitlab-merge-request', ref.project, String(pull.iid)), source: SOURCE,
    threads: [{ source: SOURCE, id: gitlabThreadId('merge_request', pull.iid) }], ...author(pull.author, agent), at: pull.created_at,
    text: [pull.title, body].filter(Boolean).join('\n\n'),
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel({ ...ref, kind: 'merge_request', iid: pull.iid }, pull.web_url), url: pull.web_url,
    meta: { ...meta({ ...ref, kind: 'merge_request', iid: pull.iid }, 'root'), ...(pull.source_branch ? { sourceBranch: pull.source_branch } : {}),
      ...(pull.target_branch ? { targetBranch: pull.target_branch } : {}) } }
}
/**
 * Builds the Trigger for a note on an Issue or merge request; returns undefined for GitLab's system notes, the agent's own notes,
 * and notes without text. An edit changes the note's `updated_at` and therefore its Trigger id, as a GitHub comment edit does.
 */
export function noteTrigger(note: GitlabNote, ref: GitlabRef, agent: string): Trigger | undefined {
  if (note.system || sameName(note.author.username, agent) || !note.body.trim()) return undefined
  const at = note.updated_at ?? note.created_at
  const url = ref.url ? `${ref.url}#note_${note.id}` : undefined
  return { id: key('gitlab-note', ref.project, ref.kind, String(ref.iid), String(note.id), note.updated_at ?? ''), source: SOURCE,
    threads: [{ source: SOURCE, id: gitlabThreadId(ref.kind, ref.iid) }], ...author(note.author, agent), at, text: note.body,
    ...(mentions(note.body, agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(ref, url), ...(url ? { url } : {}),
    meta: { ...meta(ref, String(note.id)), noteId: note.id } }
}
/** Reads the Kind and IID a Trigger carries, or undefined when it is not a GitLab Issue or merge request Trigger. */
export function gitlabRefOf(trigger: Trigger): GitlabIid | undefined {
  const kind = trigger.meta.kind
  const iid = Number(trigger.meta.iid)
  return (kind === 'issue' || kind === 'merge_request') && Number.isInteger(iid) && iid > 0 ? { kind, iid } : undefined
}

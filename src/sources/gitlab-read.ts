/** Validated project-scoped GitLab resources and explicit pagination. */
import { z } from 'zod'
import { CliError, type Commands } from '../infra/commands.ts'
import type { ThreadContext } from './kind.ts'

export const UserSchema = z.object({ id: z.number().int().positive(), username: z.string(), bot: z.boolean().optional() })
export const ObjectSchema = z.object({ iid: z.number().int().positive(), id: z.number(), title: z.string(), description: z.string().nullish(),
  author: UserSchema, created_at: z.string(), updated_at: z.string(), web_url: z.string().url(), state: z.string(),
  project_id: z.number().optional(), source_project_id: z.number().optional(), target_project_id: z.number().optional(), source_branch: z.string().optional(),
  sha: z.string().nullish(), merged_at: z.string().nullish(), closed_at: z.string().nullish(),
  head_pipeline: z.object({ id: z.number(), sha: z.string(), status: z.string(), updated_at: z.string().optional() }).nullish() })
export type GitlabObject = z.infer<typeof ObjectSchema>
const PositionSchema = z.object({
  old_path: z.string().nullish(), new_path: z.string().nullish(), old_line: z.number().int().positive().nullish(), new_line: z.number().int().positive().nullish(),
  base_sha: z.string().nullish(), start_sha: z.string().nullish(), head_sha: z.string().nullish(), position_type: z.string().optional(),
})
export const NoteSchema = z.object({ id: z.number(), body: z.string(), author: UserSchema, system: z.boolean().default(false),
  created_at: z.string(), updated_at: z.string(), type: z.string().nullish(), position: PositionSchema.nullish() })
export const DiscussionSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/), notes: z.array(NoteSchema) })
export type ObjectKind = 'issue' | 'mr'
export const collection = (kind: ObjectKind): string => kind === 'issue' ? 'issues' : 'merge_requests'
export function objectPath(kind: ObjectKind, iid: number): string {
  if (!Number.isSafeInteger(iid) || iid <= 0) throw new Error('Invalid GitLab IID')
  return `${collection(kind)}/${iid}`
}
export type GitlabReads = Pick<Commands, 'gitlab'>
const coolingUntil = new WeakMap<Commands, number>()
export const gitlabCoolingDown = (commands: Commands): boolean => (coolingUntil.get(commands) ?? 0) > Date.now()
/** Share the project's cooldown across webhook consumption and reconciliation, including paginated reads. */
export function gitlabEventReads(commands: Commands, signal?: AbortSignal): GitlabReads {
  const scoped = commands.withSignal(signal)
  return { async gitlab<T>(path: string): Promise<T> {
    if (gitlabCoolingDown(commands)) throw new CliError('GitLab event reads are cooling down', 429)
    try { return await scoped.gitlab<T>(path) }
    catch (error) {
      if (error instanceof CliError && error.code === 429) coolingUntil.set(commands, Date.now() + 30_000)
      throw error
    }
  } }
}
export async function gitlabPages<T>(commands: GitlabReads, schema: z.ZodType<T>, path: string, invalid?: (error: unknown) => void): Promise<T[]> {
  const items: T[] = []
  for (let page = 1; page <= 10000; page++) {
    const batch = z.array(z.unknown()).parse(await commands.gitlab(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`))
    for (const value of batch) {
      const parsed = schema.safeParse(value)
      if (parsed.success) items.push(parsed.data)
      else if (invalid) invalid(parsed.error)
      else throw parsed.error
    }
    if (batch.length < 100) return items
  }
  throw new Error('GitLab pagination exceeded its bound; cursor not advanced')
}
export const readMerge = async (commands: GitlabReads, iid: number): Promise<GitlabObject> => ObjectSchema.parse(await commands.gitlab(objectPath('mr', iid)))
export function resourcePath(resource: string): string {
  const match = /^gitlab\/(issue|mr)\/([1-9]\d*)(?:\/(discussions|diffs|pipelines))?$/.exec(resource)
  if (!match || (match[1] === 'issue' && match[3] && match[3] !== 'discussions')) throw new Error('Invalid GitLab resource')
  return objectPath(match[1] as ObjectKind, Number(match[2])) + (match[3] ? '/' + match[3] : '')
}
export async function readGitlab(commands: Commands, resource: string): Promise<unknown> {
  const path = resourcePath(resource)
  if (path.endsWith('/discussions')) return gitlabPages(commands, DiscussionSchema, path)
  if (path.endsWith('/diffs') || path.endsWith('/pipelines')) return gitlabPages(commands, z.unknown(), path)
  return ObjectSchema.parse(await commands.gitlab(path))
}
export const gitlabThreadContext: ThreadContext<Record<string, unknown>> = {
  messageId: trigger => String(trigger.meta.noteId ?? 'body'),
  read: async (commands, trigger, part, cursor) => {
    const kind = trigger.meta.objectKind as ObjectKind
    const iid = Number(trigger.meta.iid)
    const object = ObjectSchema.parse(await commands.gitlab(objectPath(kind, iid)))
    const root = { id: 'body', from: object.author.username, at: object.created_at, text: `${object.title}\n${object.description ?? ''}`, url: object.web_url }
    if (part === 'root') return { messages: [root], body: { object } }
    const page = cursor ? Number(cursor) : 1
    if (!Number.isSafeInteger(page) || page < 1) throw new Error('Invalid GitLab page')
    const discussions = z.array(DiscussionSchema).parse(await commands.gitlab(`${objectPath(kind, iid)}/discussions?per_page=100&page=${page}`))
    const messages = discussions.flatMap(d => d.notes.map(note => ({ id: String(note.id), from: note.author.username, at: note.updated_at,
      text: note.body,
      ...(note.position?.new_line != null && note.position.new_path ? { path: note.position.new_path, line: note.position.new_line }
        : note.position?.old_line != null && note.position.old_path ? { path: note.position.old_path, line: note.position.old_line } : {}),
      ...note.system || note.author.bot ? { bot: true as const } : {} })))
    return { messages: page === 1 ? [root, ...messages] : messages, ...(discussions.length === 100 ? { next: String(page + 1) } : {}), body: { discussions } }
  },
}

/** Default-branch reads use the same source-path restrictions as GitHub assessment reads. */
export async function readGitlabRepositoryPath(commands: Commands, path: string, kind: 'file' | 'directory'): Promise<string> {
  const parts = path.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) throw new Error('Only non-hidden repository source paths are available')
  const encoded = encodeURIComponent(parts.join('/')).replace(/[!'()*~]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  if (kind === 'file') {
    const file = z.object({ encoding: z.literal('base64'), content: z.string() }).parse(await commands.gitlab(`repository/files/${encoded}?ref=HEAD`))
    return Buffer.from(file.content, 'base64').toString('utf8')
  }
  const entries = await gitlabPages(commands, z.object({ name: z.string() }), `repository/tree?path=${encoded}`)
  return entries.map(entry => entry.name).filter(name => !name.startsWith('.') && name !== 'node_modules').sort().join('\n')
}

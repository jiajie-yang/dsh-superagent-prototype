/** GitLab REST API v4 client used by the GitLab Source: reads Issues, merge requests and notes, and writes notes. */
import { z } from 'zod'
import { validItems } from '../infra/commands.ts'
import { GitlabIssueSchema, GitlabMergeRequestSchema, GitlabNoteSchema, GitlabUserSchema, type GitlabIssue, type GitlabKind,
  type GitlabMergeRequest, type GitlabNote, type GitlabUser } from './gitlab-trigger.ts'

/** The service environment variable holding the bot's token; never a settings field, prompt value or worker variable. */
export const GITLAB_TOKEN_ENV = 'DSH_SUPERAGENT_GITLAB_TOKEN'
/** Reads the bot token from the process environment. */
export const gitlabToken = (environment: NodeJS.ProcessEnv = process.env): string | undefined =>
  environment[GITLAB_TOKEN_ENV]?.trim() || undefined
/** Thrown when the Source is asked to read or write GitLab without the token it needs. */
export class GitlabTokenError extends Error {
  constructor() { super(`${GITLAB_TOKEN_ENV} is not set`) }
}
/** GitLab's HTTP answer, with its status so a Channel can tell a deleted target from a retryable failure. */
export class GitlabHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
interface ProjectRef { baseUrl: string; project: string }
type Query = Record<string, string | number | undefined>
type Transport = (url: URL, init: RequestInit) => Promise<Response>
/** A page of a GitLab list: `next` is the `x-next-page` header as a number, absent on the last page. */
export interface GitlabPage<T> { items: T[]; next?: number }
/** The reads and writes the Source needs from one GitLab project; the REST client implements it and tests fake it. */
export interface GitlabApi {
  readonly baseUrl: string
  readonly project: string
  me(): Promise<GitlabUser>
  getIssue(iid: number): Promise<GitlabIssue>
  getMergeRequest(iid: number): Promise<GitlabMergeRequest>
  /** Issues whose `updated_at` is newer than `since`, newest first. */
  updatedIssues(since: string): Promise<GitlabIssue[]>
  /** Merge requests whose `updated_at` is newer than `since`, newest first. */
  updatedMergeRequests(since: string): Promise<GitlabMergeRequest[]>
  /** Notes newer than `since`, oldest first; `notesPage` pages a Thread instead. */
  notes(kind: GitlabKind, iid: number, since: string): Promise<GitlabNote[]>
  /** One page of a Thread, oldest first, for assessments. */
  notesPage(kind: GitlabKind, iid: number, page: number): Promise<GitlabPage<GitlabNote>>
  /** Whether a note carrying `marker` is already on the Issue or merge request, for idempotent replies. */
  findNote(kind: GitlabKind, iid: number, marker: string): Promise<boolean>
  postNote(kind: GitlabKind, iid: number, body: string): Promise<void>
}
const PAGE_SIZE = 100
/** A bound on pages read in one round, so a busy project cannot hold a poll open indefinitely. */
const MAX_PAGES = 5
const TIMEOUT_MS = 30_000
/** Describes a failed GitLab answer without copying anything secret into health or the panel. */
function failure(status: number, text: string): string {
  let detail = text.trim()
  try {
    const parsed = JSON.parse(text) as { message?: unknown; error?: unknown }
    const message = Array.isArray(parsed.message) ? parsed.message.join('; ') : parsed.message ?? parsed.error
    if (typeof message === 'string' && message.trim()) detail = message.trim()
  } catch { /* Plain-text answers are kept as they came. */ }
  return `GitLab answered HTTP ${status}${detail ? `: ${detail.slice(0, 300)}` : ''}`
}
/** A GitLab client over the REST API v4; `transport` lets tests answer without a network. */
export class RestGitlabApi implements GitlabApi {
  readonly baseUrl: string
  readonly project: string
  private readonly token: string
  constructor(baseUrl: string, project: string, token: string | undefined = gitlabToken(), private readonly transport: Transport = fetch,
    private readonly signal?: AbortSignal) {
    if (!token) throw new GitlabTokenError()
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.project = project
    this.token = token
  }
  private endpoint(kind: GitlabKind, iid: number, suffix = ''): string {
    return `/projects/${encodeURIComponent(this.project)}/${kind === 'issue' ? 'issues' : 'merge_requests'}/${iid}${suffix}`
  }
  private async request(path: string, query: Query = {}, method: 'GET' | 'POST' = 'GET', payload?: unknown): Promise<{ body: unknown; headers: Headers }> {
    const url = new URL(`${this.baseUrl}/api/v4${path}`)
    for (const [name, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(name, String(value))
    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    const response = await this.transport(url, { method, signal: this.signal ? AbortSignal.any([this.signal, timeout]) : timeout,
      headers: { 'PRIVATE-TOKEN': this.token, accept: 'application/json', ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) })
    const text = await response.text()
    if (!response.ok) throw new GitlabHttpError(response.status, failure(response.status, text))
    return { body: text ? JSON.parse(text) as unknown : undefined, headers: response.headers }
  }
  private async page<T>(schema: z.ZodType<T>, path: string, query: Query): Promise<GitlabPage<T>> {
    const { body, headers } = await this.request(path, query)
    const items = validItems(schema, z.array(z.unknown()).parse(body))
    const next = Number(headers.get('x-next-page') ?? '')
    return { items, ...(Number.isInteger(next) && next > 0 ? { next } : {}) }
  }
  /** Reads newest-first pages until an item is at or before the cursor, so a quiet project costs one page. */
  private async changed<T extends { updated_at: string }>(schema: z.ZodType<T>, path: string, since: string): Promise<T[]> {
    const cursor = Date.parse(since)
    const items: T[] = []
    let page = 1
    for (let read = 0; read < MAX_PAGES; read++) {
      const result = await this.page(schema, path, { scope: 'all', state: 'all', order_by: 'updated_at', sort: 'desc', per_page: PAGE_SIZE, page })
      items.push(...result.items.filter(item => Date.parse(item.updated_at) > cursor))
      if (result.items.some(item => !(Date.parse(item.updated_at) > cursor)) || result.next === undefined) break
      page = result.next
    }
    return items
  }
  private async notePage(kind: GitlabKind, iid: number, page: number, sort: 'asc' | 'desc', order: 'created_at' | 'updated_at'): Promise<GitlabPage<GitlabNote>> {
    return this.page(GitlabNoteSchema, this.endpoint(kind, iid, '/notes'), { sort, order_by: order, per_page: PAGE_SIZE, page })
  }
  async me(): Promise<GitlabUser> {
    const { body } = await this.request('/user')
    return GitlabUserSchema.parse(body)
  }
  async getIssue(iid: number): Promise<GitlabIssue> {
    const { body } = await this.request(this.endpoint('issue', iid))
    return GitlabIssueSchema.parse(body)
  }
  async getMergeRequest(iid: number): Promise<GitlabMergeRequest> {
    const { body } = await this.request(this.endpoint('merge_request', iid))
    return GitlabMergeRequestSchema.parse(body)
  }
  updatedIssues(since: string): Promise<GitlabIssue[]> {
    return this.changed(GitlabIssueSchema, `/projects/${encodeURIComponent(this.project)}/issues`, since)
  }
  updatedMergeRequests(since: string): Promise<GitlabMergeRequest[]> {
    return this.changed(GitlabMergeRequestSchema, `/projects/${encodeURIComponent(this.project)}/merge_requests`, since)
  }
  async notes(kind: GitlabKind, iid: number, since: string): Promise<GitlabNote[]> {
    const cursor = Date.parse(since)
    const notes: GitlabNote[] = []
    let page = 1
    for (let read = 0; read < MAX_PAGES; read++) {
      // Update ordering makes an edited note visible without scanning the whole history; verify the parameter on the instance.
      const result = await this.notePage(kind, iid, page, 'desc', 'updated_at')
      const fresh = result.items.filter(note => Date.parse(note.updated_at ?? note.created_at) > cursor)
      notes.push(...fresh)
      if (fresh.length < result.items.length || result.next === undefined) break
      page = result.next
    }
    // Pages were read newest first; the Engine receives a Thread's notes in the order they were written.
    return notes.reverse()
  }
  async notesPage(kind: GitlabKind, iid: number, page: number): Promise<GitlabPage<GitlabNote>> {
    return this.notePage(kind, iid, page, 'asc', 'created_at')
  }
  async findNote(kind: GitlabKind, iid: number, marker: string): Promise<boolean> {
    let page = 1
    // The marker is at most one poll old; two pages absorb a busy comment thread without scanning the whole history.
    for (let read = 0; read < 2; read++) {
      // Update ordering makes an edited note visible without scanning the whole history; verify the parameter on the instance.
      const result = await this.notePage(kind, iid, page, 'desc', 'updated_at')
      if (result.items.some(note => note.body.includes(marker))) return true
      if (result.next === undefined) return false
      page = result.next
    }
    return false
  }
  async postNote(kind: GitlabKind, iid: number, body: string): Promise<void> {
    const { body: answer } = await this.request(this.endpoint(kind, iid, '/notes'), {}, 'POST', { body })
    z.looseObject({ id: z.number() }).parse(answer)
  }
}
/** Builds the REST client for the configured instance and project; the token comes from the process environment. */
export const createGitlabApi = (config: ProjectRef, token?: string, signal?: AbortSignal): GitlabApi =>
  new RestGitlabApi(config.baseUrl, config.project, token, fetch, signal)

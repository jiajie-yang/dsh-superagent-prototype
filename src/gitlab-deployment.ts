/** GitLab deployment identity and instance validation. */
import { z } from 'zod'
import { executable, GitlabAccountsSchema, type Deployment, type Machine, type Probe } from './deployment.ts'
import { workerBin } from './infra/environment.ts'
import { SetupError } from './setup.ts'

export function gitlabUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use an HTTPS GitLab instance at the domain root')
  return url.origin
}
export async function resolveGitlab(machine: Machine, value: unknown, probe: Probe): Promise<Deployment> {
  try {
    const config = GitlabAccountsSchema.parse(value ?? {})
    const baseUrl = gitlabUrl(config.baseUrl)
    if (!config.project || config.project.startsWith('/') || config.project.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Set a project path, including its group')
    const host = new URL(baseUrl).host
    const cli = executable(config.cli, process.env.PATH ?? '', workerBin(machine.stateDir))
    const api = async (path: string) => JSON.parse(await probe([cli, 'api', '--hostname', host, path])) as unknown
    const user = z.object({ id: z.number().int().positive(), username: z.string(), email: z.string().email() }).parse(await api('user'))
    const project = z.object({ id: z.number().int().positive(), path_with_namespace: z.string(), http_url_to_repo: z.string().url(),
      permissions: z.object({ project_access: z.object({ access_level: z.number() }).nullable(), group_access: z.object({ access_level: z.number() }).nullable() }) }).parse(await api(`projects/${encodeURIComponent(config.project)}`))
    if (new URL(project.http_url_to_repo).origin !== baseUrl) throw new Error('Project clone host does not match this instance')
    if (Math.max(project.permissions.project_access?.access_level ?? 0, project.permissions.group_access?.access_level ?? 0) < 30) throw new Error('The agent needs Developer access or higher; actual push is verified during delivery')
    return { ...machine, repositoryProvider: 'gitlab', repository: project.path_with_namespace,
      gitlab: { baseUrl, host, cli, projectId: project.id, project: project.path_with_namespace, userId: user.id, username: user.username, email: user.email } }
  } catch { throw new SetupError('gitlabSetupFailed') }
}

/** GitLab comments and discussion replies with read-before-retry markers. */
import type { OutboundMessage } from '../core/index.ts'
import type { SourceContext } from './host.ts'
import { CliError } from '../infra/commands.ts'
import { gitlabPages, NoteSchema, objectPath, type ObjectKind } from './gitlab-read.ts'
export async function sendGitlab(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const account = host.commands.deployment.gitlab
  const address = message.channel.address
  if (!account || address.instance !== account.baseUrl || address.projectId !== String(account.projectId)) throw new Error('GitLab reply is outside the bound project')
  if (address.objectKind !== 'issue' && address.objectKind !== 'mr') throw new Error('Invalid GitLab reply kind')
  const path = objectPath(address.objectKind as ObjectKind, Number(address.iid))
  const discussion = address.discussionId
  if (discussion && !/^[a-zA-Z0-9_-]+$/.test(discussion)) throw new Error('Invalid discussion ID')
  const marker = `<!-- dsh-superagent:${message.id} -->`
  try {
    const notes = await gitlabPages(host.commands, NoteSchema, `${path}/notes`)
    if (notes.some(note => note.author.id === account.userId && note.body.includes(marker))) return 'sent'
    await host.commands.gitlab(discussion ? `${path}/discussions/${discussion}/notes` : `${path}/notes`, 'POST', { body: `${message.text}\n\n${marker}` })
    return 'sent'
  } catch (error) {
    // 404 can also mean access was revoked; never drop such messages.
    if (error instanceof CliError && error.code === 410) return 'gone'
    throw error
  }
}

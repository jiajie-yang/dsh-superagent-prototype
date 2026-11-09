/** Main plugin entry: mounts the Runtime and provides its restart callback for deployment account changes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { Runtime } from './app/runtime.ts'
import { Config, machineOf, type DeploymentConfig } from './deployment.ts'

export const name = 'dsh-superagent'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const machine = machineOf(config)
  // The management panel provides its own settings UI, so disable DSH's auto-generated settings page.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // Volatile limits update in place without a restart; account changes restart dsh-superagent. DSH's settings service stops
  // serving this entry while dsh-superagent restarts and rereads it only on a configuration write, so trigger `describe()`
  // after restart to keep open configuration forms editable without a page reload.
  // TODO: drop the read once DSH's settings service rereads an entry whose plugin becomes active again.
  const restart = (): void => {
    ctx.fiber.restart().then(() => { ctx.get('settings')?.describe() }).catch((error: unknown) => { ctx.logger.error('dsh-superagent restart failed: %s', String(error)) })
  }
  // The owner publishes the service before setup, and can be withdrawn without losing the entry's restart callback.
  const owner = ctx.plugin({ name: 'dsh-superagent-runtime', inject, apply(scope: Context) {
    const runtime = new Runtime(scope, machine, restart)
    let closing = false
    scope.effect(() => async () => { closing = true; await runtime.stop() })
    void runtime.ready.then(() => {
      if (!closing) scope.logger.info(runtime.configured() ? 'dsh-superagent ready; the Superagent sidebar entry opens the management panel' : `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
    }, error => {
      if (closing) return
      scope.logger.error(error)
      // Do not make the readiness observer wait for the cleanup it starts.
      void Promise.resolve(scope.fiber.dispose()).catch((error: unknown) => { scope.logger.error(error) })
    })
  } })
  await owner
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'

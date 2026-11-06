/** Cordis service publication and Runtime ownership during asynchronous setup. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import * as entrypoint from '../src/index.ts'
import * as github from '../src/sources/github.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { SourceContext } from '../src/sources/host.ts'

interface ControlledRuntime {
  ready: Promise<void>; finish(): void; fail(error: Error): void; waiting: boolean
  stop: ReturnType<typeof vi.fn>; sources: SourceRegistry
}
const lifecycle = vi.hoisted(() => ({ instances: [] as ControlledRuntime[] }))
vi.mock('../src/app/runtime.ts', () => ({ Runtime: class implements ControlledRuntime {
  ready: Promise<void>
  finish!: () => void
  fail!: (error: Error) => void
  waiting = false
  sources = new SourceRegistry(() => SettingsSchema.parse({}))
  stop = vi.fn(async () => { this.finish() })
  constructor(ctx: Context) {
    this.ready = new Promise<void>((resolve, reject) => { this.finish = resolve; this.fail = reject })
    lifecycle.instances.push(this)
    ctx.reflect.provide('orchestrator', this as never)
  }
  configured() { return !this.waiting }
  get setupProblem() { return this.waiting ? { detail: 'Account configuration required' } : undefined }
  context(): SourceContext {
    return { ready: this.ready, configured: () => false, report: () => {} } as unknown as SourceContext
  }
} }))

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  lifecycle.instances = []
})
function mount(withSource = true) {
  const ctx = new Context(); contexts.push(ctx)
  const logs: { type: string; args: unknown[] }[] = []
  ctx.logger.exporter({ export: message => { logs.push(message) } })
  for (const name of entrypoint.inject) ctx.reflect.provide(name, {} as never)
  const main = ctx.plugin(entrypoint, { stateDir: '/tmp/entrypoint-regression' })
  const source = withSource ? ctx.plugin(github) : undefined
  return { ctx, main, source, logs }
}

it('publishes the orchestrator and registers the real Source before readiness, then cleans up on unload', async () => {
  const { ctx, main, source, logs } = mount()
  await main; await source
  const runtime = lifecycle.instances[0]!
  expect(runtime.sources.kind('github')).toBeDefined()
  expect(ctx.get('orchestrator')).toBeDefined()
  expect(logs.some(log => String(log.args[0]).includes('dsh-superagent ready;'))).toBe(false)
  runtime.finish()
  await vi.waitFor(() => expect(logs.some(log => String(log.args[0]).includes('dsh-superagent ready;'))).toBe(true))
  await main.dispose()
  expect(runtime.stop).toHaveBeenCalledOnce()
  expect(ctx.get('orchestrator')).toBeUndefined()
  expect(runtime.sources.kind('github')).toBeUndefined()
})

it('logs rejected readiness, withdraws the service and Source, and allows the outer entry to restart', async () => {
  const { ctx, main, source, logs } = mount()
  await main; await source
  const runtime = lifecycle.instances[0]!, failure = new Error('Master Session initialization failed')
  runtime.fail(failure)
  await vi.waitFor(() => expect(ctx.get('orchestrator')).toBeUndefined())
  await vi.waitFor(() => expect(runtime.stop).toHaveBeenCalledOnce())
  expect(runtime.sources.kind('github')).toBeUndefined()
  expect(logs.some(log => log.type === 'error' && log.args.includes(failure))).toBe(true)
  await main.restart()
  const recovered = lifecycle.instances[1]!
  recovered.finish()
  await vi.waitFor(() => expect(recovered.sources.kind('github')).toBeDefined())
  expect(ctx.get('orchestrator')).toBeDefined()
  await main.dispose()
  expect(runtime.stop).toHaveBeenCalledOnce()
  expect(recovered.stop).toHaveBeenCalledOnce()
})

it('keeps expected setup-pending service available for account configuration', async () => {
  const { ctx, main, source, logs } = mount()
  await main; await source
  const runtime = lifecycle.instances[0]!
  runtime.waiting = true; runtime.finish()
  await vi.waitFor(() => expect(logs.some(log => String(log.args[0]).includes('waiting for setup'))).toBe(true))
  expect(ctx.get('orchestrator')).toBeDefined()
  expect(runtime.sources.kind('github')).toBeDefined()
  expect(runtime.stop).not.toHaveBeenCalled()
  expect(logs.some(log => log.type === 'error')).toBe(false)
})

it.each(['success', 'failure'])('unloads during pending readiness without a late %s log', async result => {
  // Isolate late readiness logging from the Source's health reporting.
  const { ctx, main, source, logs } = mount(result === 'success')
  await main; await source
  const runtime = lifecycle.instances[0]!
  const failure = new Error('Setup aborted during cleanup')
  if (result === 'failure') runtime.stop.mockImplementationOnce(async () => { runtime.fail(failure) })
  // The mock stop completes the pending startup, as aborting a setup probe does.
  await main.dispose()
  expect(runtime.stop).toHaveBeenCalledOnce()
  expect(ctx.get('orchestrator')).toBeUndefined()
  expect(runtime.sources.kind('github')).toBeUndefined()
  expect(logs.some(log => log.type === 'error' || String(log.args[0]).includes('dsh-superagent ready;'))).toBe(false)
})

it.each(['failure first', 'unload first'])('cleans up once when failure and unload race: %s', async order => {
  const { ctx, main, source } = mount()
  await main; await source
  const runtime = lifecycle.instances[0]!, failure = new Error('Startup failed during unload')
  if (order === 'failure first') { runtime.fail(failure); await Promise.resolve() }
  const disposing = main.dispose()
  if (order === 'unload first') runtime.fail(failure)
  await disposing
  expect(runtime.stop).toHaveBeenCalledOnce()
  expect(ctx.get('orchestrator')).toBeUndefined()
  expect(runtime.sources.kind('github')).toBeUndefined()
})

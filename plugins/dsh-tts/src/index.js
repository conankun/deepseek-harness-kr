/**
 * Host entry of dsh-tts: register the speech routes on the web
 * server. Disabled means the whole feature is absent — no /state, no /speak,
 * no listener on the client — so nothing changes for a profile that never
 * opted in.
 * @module dsh-tts
 */
import { normalize } from './config.js'
import { createSpeakHandler, createStateHandler, SPEAK_ROUTE, STATE_ROUTE } from './host.js'

/** Stable Cordis plugin name; the Loader row id in cordis.patch.yml is 'tts'. */
export const name = 'dsh-tts'

/** The routes are unreadable without the web server. */
export const inject = ['webServer']

/**
 * Activate the host half.
 * @param ctx - Cordis context carrying the web server service.
 * @param rawConfig - Loader-row config from cordis.patch.yml.
 */
export function apply(ctx, rawConfig) {
  const config = normalize(rawConfig)
  if (!config.enabled) return
  ctx.effect(() => {
    const disposeState = ctx.webServer.register({
      kind: 'exact',
      path: STATE_ROUTE,
      handler: createStateHandler(config),
    })
    const disposeSpeak = ctx.webServer.register({
      kind: 'exact',
      path: SPEAK_ROUTE,
      handler: createSpeakHandler(config),
    })
    return () => {
      disposeSpeak()
      disposeState()
    }
  }, 'dsh-tts: speech routes')
}

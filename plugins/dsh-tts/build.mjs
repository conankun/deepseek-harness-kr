/**
 * Bundle src/client/index.js into lib/client.js.
 *
 * The bundle is committed so the plugin works without a build step: the web
 * client loads it through window.__ModuleLoader__.load, which expects a
 * CommonJS-shaped factory returning module.exports.
 *
 * esbuild is resolved from ESBUILD (a path to esbuild/lib/main.js) first, then
 * from the installed package.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const BANNER = 'window.__ModuleLoader__.load({ id: "dsh-tts", factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;'
const FOOTER = 'return module.exports; } });'

/** Return the esbuild module's API, or explain how to make it resolvable. */
async function loadEsbuild() {
  const override = process.env.ESBUILD
  if (override) {
    try {
      const loaded = await import(pathToFileURL(override).href)
      return loaded.build ? loaded : loaded.default
    } catch (error) {
      throw new Error('dsh-tts: cannot load ESBUILD=' + override + ': ' + String(error?.message ?? error))
    }
  }
  try {
    const loaded = await import('esbuild')
    return loaded.build ? loaded : loaded.default
  } catch {
    throw new Error('dsh-tts: esbuild is not installed; set ESBUILD to the path of esbuild/lib/main.js')
  }
}

const esbuild = await loadEsbuild()
await esbuild.build({
  entryPoints: [join(here, 'src/client/index.js')],
  outfile: join(here, 'lib/client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  banner: { js: BANNER },
  footer: { js: FOOTER },
  legalComments: 'none',
  logLevel: 'info',
})
console.log('dsh-tts: wrote lib/client.js')

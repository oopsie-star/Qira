import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// One timestamp per build: baked into the bundle and written to version.json,
// so an open tab can tell that the server now has a newer build.
const BUILT_AT = Date.now()

function versionFile(): Plugin {
  return {
    name: 'qira-version-file',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ built_at: BUILT_AT }) })
    },
  }
}

export default defineConfig({
  plugins: [react(), versionFile()],
  base: process.env.VITE_APP_BASE_URL ?? '/',
  define: { __APP_BUILT_AT__: JSON.stringify(BUILT_AT) },
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  build: { target: 'es2020' },
  server: { port: 5173 },
})

import { defineConfig } from 'vite'
import base from './vite.e2e.config.mts'

export default defineConfig({ ...base, server: { ...base.server, port: 4176, hmr: false } })

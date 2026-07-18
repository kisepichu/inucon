import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// portal サーバーの静的配信(portal/src/infrastructure/http/static.ts)が
// web/dist をそのまま配信する。開発時は Vite dev server から
// /api, /auth を portal(既定 http://localhost:3000)へプロキシする。
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:3000",
      "/auth": "http://localhost:3000"
    }
  },
  build: {
    outDir: "dist"
  }
})

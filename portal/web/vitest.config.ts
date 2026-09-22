import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

// Task 5: wizard コンポーネントの単体テスト用の Vitest 設定。
// jsdom + @testing-library/react を使う。setup.ts で jest-dom の
// マッチャーを読み込む。
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"]
  }
})

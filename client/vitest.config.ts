import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    environmentOptions: {
      jsdom: { url: "https://blog.naver.com/example/223456789012" },
    },
    coverage: {
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage",
      thresholds: {
        branches: 85,
        functions: 85,
        lines: 85,
        statements: 85,
      },
    },
  },
});

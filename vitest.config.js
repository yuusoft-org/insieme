import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["*.test.js", "spec/**/*.test.js"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.js"],
      exclude: [
        "node_modules/",
        "coverage/",
        "dist/",
        "**/*.config.*",
        "src/index.js",
      ],
      thresholds: {
        lines: 86,
        statements: 85,
        functions: 88,
        branches: 75,
      },
    },
  },
});

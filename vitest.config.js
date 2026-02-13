import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['*.test.js', 'spec/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src-next/**/*.js'],
      exclude: [
        'node_modules/',
        'coverage/',
        'dist/',
        '**/*.config.*'
      ]
    }
  }
})

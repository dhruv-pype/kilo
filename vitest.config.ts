import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/**/*.d.ts'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@common': path.resolve(__dirname, 'src/common'),
      '@bot-runtime': path.resolve(__dirname, 'src/bot-runtime'),
      '@skill-engine': path.resolve(__dirname, 'src/skill-engine'),
      '@llm-gateway': path.resolve(__dirname, 'src/llm-gateway'),
      '@database': path.resolve(__dirname, 'src/database'),
      '@cache': path.resolve(__dirname, 'src/cache'),
      '@api': path.resolve(__dirname, 'src/api'),
    },
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 列表 keyed diff、行节点按钮缓存、聚合气泡配色等都发生在 DOM 层，必须有真实 DOM
    environment: 'jsdom',
    include: ['test/frontend/**/*.test.js'],
  },
});
import { defineConfig } from 'vitest/config';

// 必须有自己的配置：vitest v4 会从 CWD 向上查找配置文件，
// 没有这份的话会被仓库根目录的 vitest.config.mjs 接管，
// 后端测试会被前端测试的 include 规则（test/frontend/**）过滤掉。
export default defineConfig({
  test: {
    include: ['lib/**/*.test.js', 'routes/**/*.test.js', 'scripts/**/*.test.js'],
  },
});
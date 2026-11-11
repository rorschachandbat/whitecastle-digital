import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  // 相对资源路径同时适用于项目站点和其他静态托管目录。
  base: './',
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        configEditor: fileURLToPath(new URL('./config-editor.html', import.meta.url)),
      },
    },
  },
});

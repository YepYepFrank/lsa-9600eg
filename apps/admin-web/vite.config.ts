import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

// 相对路径 + 哈希路由：同一份构建产物既能在 EG 上直出（http://<EG>/），
// 也能挂在子站反代的子路径下（https://<子站>/eg/<柜号>/，开发计划 §5）。页面里的接口地址一律写相对路径 api/...
export default defineConfig({
  base: './',
  plugins: [vue()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: { target: 'chrome88' },
  server: {
    port: Number(process.env.PORT) || 8798,
    host: '127.0.0.1',
    proxy: {
      '/api/video': { target: process.env.EG_VIDEO || 'http://127.0.0.1:9110' },
      '/api': { target: process.env.EG_AGENT || 'http://127.0.0.1:9100' },
    },
  },
})

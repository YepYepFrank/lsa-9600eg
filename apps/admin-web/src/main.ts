import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import './styles/tokens.css'
import './styles/element.css'
import './styles/app.css'
import App from './App.vue'
import { router } from './router'
import { applyTheme } from './theme'

applyTheme()
createApp(App).use(router).use(ElementPlus, { locale: zhCn }).mount('#app')

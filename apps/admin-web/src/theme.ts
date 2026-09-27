/* 明 / 暗主题：默认暗色（配电室里看），记在本机浏览器 */
import { ref } from 'vue'

const KEY = 'lsa-eg-theme'
export const theme = ref<'dark' | 'light'>('dark')

export function applyTheme(t?: 'dark' | 'light') {
  try {
    theme.value = t ?? ((localStorage.getItem(KEY) as 'dark' | 'light' | null) || 'dark')
    localStorage.setItem(KEY, theme.value)
  } catch {
    theme.value = t ?? 'dark'
  }
  const html = document.documentElement
  html.dataset['theme'] = theme.value
  html.classList.toggle('dark', theme.value === 'dark')
}

export const toggleTheme = () => applyTheme(theme.value === 'dark' ? 'light' : 'dark')

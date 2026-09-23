import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import './styles.css'

// dev only: `?theme=dark` picks the theme before the app reads it, so a headless
// screenshot can take either one without clicking the toggle
if (import.meta.env.DEV) {
  const theme = new URLSearchParams(window.location.search).get('theme')
  if (theme === 'light' || theme === 'dark') localStorage.setItem('tally-theme', theme)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

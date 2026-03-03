import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/base.css'
import './styles/layout.css'
import './styles/panels.css'
import './styles/settings.css'
import './styles/context-menu.css'
import './styles/notifications.css'
import './styles/env-snippets.css'
import './styles/resize.css'
import './styles/file-browser.css'
import './styles/path-linker.css'
import './styles/prompt-box.css'
import './styles/claude-agent.css'
import './styles/session-dashboard.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

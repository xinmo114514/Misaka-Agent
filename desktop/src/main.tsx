import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { initializeTheme } from './theme/useTheme'
import { registerRendererDiagnostics, reportThroughShell } from './lib/rendererDiagnostics'

initializeTheme()

// What the shell's main process cannot see from here: whether this thread was able to run at all.
registerRendererDiagnostics({ report: reportThroughShell })

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

import React from 'react'
import { createRoot } from 'react-dom/client'

import TestPage from './pages/TestPage'

const root = createRoot(document.getElementById('root') as HTMLElement)
root.render(
  <React.StrictMode>
    <TestPage />
  </React.StrictMode>,
)

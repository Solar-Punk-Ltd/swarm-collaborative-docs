import React from 'react'
import { createRoot } from 'react-dom/client'

import App from './pages/App'
import { consumeInviteFromUrl } from './utils/url'

consumeInviteFromUrl()

// TODO: react strict mode closes the WS connection
const root = createRoot(document.getElementById('root') as HTMLElement)
root.render(
  // <React.StrictMode>
  <App />,
  // </React.StrictMode>,
)

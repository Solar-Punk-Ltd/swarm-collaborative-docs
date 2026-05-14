import { DOCTYPE_KEY, TOPIC_KEY, TRANSPORT_KEY } from './constants'

const BEE_API_ENDPOINT_BZZ = 'bzz'
export const DOCID_URL_PARAM = 'docId'
export const TRANSPORT_URL_PARAM = 'trans'
export const DOCTYPE_URL_PARAM = 'docType'

const isWindowDefined = typeof window !== 'undefined'

export const buildInviteLink = (docId: string, transport: string, docType: string) => {
  const origin = isWindowDefined ? window.location.origin : ''
  const m = isWindowDefined ? window.location.pathname.match(/^\/bzz\/([^/]+)/) : null
  const base = m && m[1] ? `${origin}/${BEE_API_ENDPOINT_BZZ}/${m[1]}/` : `${origin}/`

  return `${base}?${DOCID_URL_PARAM}=${encodeURIComponent(docId)}&${TRANSPORT_URL_PARAM}=${transport}&${DOCTYPE_URL_PARAM}=${docType}`
}

export const parseURLParams = () => {
  if (!isWindowDefined) {
    return
  }

  const params = new URLSearchParams(window.location.search)
  const docIdParam = params.get(DOCID_URL_PARAM)
  const transportParam = params.get(TRANSPORT_URL_PARAM)
  const docTypeParam = params.get(DOCTYPE_URL_PARAM)

  if (docTypeParam) {
    localStorage.setItem(DOCTYPE_KEY, docTypeParam)
  }

  if (transportParam) {
    localStorage.setItem(TRANSPORT_KEY, transportParam)
  }

  if (docIdParam) {
    localStorage.setItem(TOPIC_KEY, docIdParam)
  }
}

import { Doc, Text } from 'yjs'

export const SEED = 'content'

export const commonPrefixLen = (a: string, b: string): number => {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i++
  }

  return i
}

export const commonSuffixLen = (a: string, b: string, prefixLen: number): number => {
  let i = 0
  const maxLen = Math.min(a.length, b.length) - prefixLen
  while (i < maxLen && a[a.length - 1 - i] === b[b.length - 1 - i]) {
    i++
  }

  return i
}

export const applyDiff = (yText: Text, yDoc: Doc, oldValue: string, newValue: string): void => {
  const prefix = commonPrefixLen(oldValue, newValue)
  const suffix = commonSuffixLen(oldValue, newValue, prefix)
  const deleteCount = oldValue.length - prefix - suffix
  const insertText = newValue.slice(prefix, newValue.length - suffix)

  if (deleteCount === 0 && insertText.length === 0) {
    return
  }

  yDoc.transact(() => {
    if (deleteCount > 0) {
      yText.delete(prefix, deleteCount)
    }

    if (insertText.length > 0) {
      yText.insert(prefix, insertText)
    }
  })
}

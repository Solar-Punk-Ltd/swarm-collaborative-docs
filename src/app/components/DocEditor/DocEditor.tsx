import React, { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'

import './DocEditor.scss'

interface DocEditorProps {
  doc: Y.Doc | null
  disabled?: boolean
}

function commonPrefixLen(a: string, b: string): number {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++

  return i
}

function commonSuffixLen(a: string, b: string, prefixLen: number): number {
  let i = 0
  const maxLen = Math.min(a.length, b.length) - prefixLen
  while (i < maxLen && a[a.length - 1 - i] === b[b.length - 1 - i]) i++

  return i
}

// Apply only the diff between oldValue and newValue to Y.Text.
// This preserves other users' items that are outside the changed range.
function applyDiff(yText: Y.Text, doc: Y.Doc, oldValue: string, newValue: string): void {
  const prefix = commonPrefixLen(oldValue, newValue)
  const suffix = commonSuffixLen(oldValue, newValue, prefix)
  const deleteCount = oldValue.length - prefix - suffix
  const insertText = newValue.slice(prefix, newValue.length - suffix)

  if (deleteCount === 0 && insertText.length === 0) return

  doc.transact(() => {
    if (deleteCount > 0) yText.delete(prefix, deleteCount)

    if (insertText.length > 0) yText.insert(prefix, insertText)
  })
}

export const DocEditor: React.FC<DocEditorProps> = ({ doc, disabled = false }) => {
  const yTextRef = useRef<Y.Text | null>(null)
  const prevContentRef = useRef('')
  const [content, setContent] = useState('')

  useEffect(() => {
    if (!doc) return

    const yText = doc.getText('content')
    yTextRef.current = yText

    const initial = yText.toString()
    prevContentRef.current = initial
    setContent(initial)

    const observer = () => {
      const text = yText.toString()
      prevContentRef.current = text
      setContent(text)
    }

    yText.observe(observer)

    return () => yText.unobserve(observer)
  }, [doc])

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (!yTextRef.current || !doc) return

    const newValue = e.target.value
    const oldValue = prevContentRef.current
    // Update prevContent immediately so rapid keystrokes diff against the right base
    prevContentRef.current = newValue

    applyDiff(yTextRef.current, doc, oldValue, newValue)
  }

  if (!doc) {
    return <div className="doc-editor doc-editor--loading">Connecting to document…</div>
  }

  return (
    <div className="doc-editor">
      <textarea
        className="doc-editor__textarea"
        value={content}
        onChange={handleChange}
        disabled={disabled}
        placeholder="Start typing — changes sync across peers via Swarm…"
        spellCheck={false}
      />
    </div>
  )
}

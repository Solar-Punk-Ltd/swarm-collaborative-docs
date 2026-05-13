import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Doc, Text } from 'yjs'

import { colorForAddress, getCaretXY } from '../../utils/peers'
import { AwarenessState } from '../../utils/types'
import { applyDiff, SEED } from '../../utils/yjs'

import './DocEditor.scss'

interface DocEditorProps {
  yDoc: Doc | null
  filePathKey?: string
  disabled?: boolean
  awareness?: Map<string, AwarenessState>
  onCursorChange?: (cursor: { anchor: number; head: number } | null) => void
}

interface CursorBadge {
  address: string
  username: string
  color: string
  top: number
  left: number
  lineHeight: number
}

export const DocEditor: React.FC<DocEditorProps> = ({
  yDoc,
  disabled = false,
  filePathKey = SEED,
  awareness,
  onCursorChange,
}) => {
  const yTextRef = useRef<Text | null>(null)
  const prevContentRef = useRef('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [content, setContent] = useState('')
  const [scrollTop, setScrollTop] = useState(0)
  const [badges, setBadges] = useState<CursorBadge[]>([])

  useEffect(() => {
    if (!yDoc) {
      return
    }

    const yText = yDoc.getText(filePathKey)
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
  }, [yDoc, filePathKey])

  useLayoutEffect(() => {
    const el = textareaRef.current

    if (!el || !awareness || awareness.size === 0) {
      setBadges([])

      return
    }

    const style = window.getComputedStyle(el)
    const lineHeight = parseFloat(style.lineHeight)
    const next: CursorBadge[] = []

    for (const [address, state] of awareness) {
      if (state.cursor) {
        const pos = Math.max(0, Math.min(state.cursor.anchor, el.value.length))
        const { top, left } = getCaretXY(el, pos)
        next.push({
          address,
          username: state.username,
          color: colorForAddress(address),
          top: top - scrollTop,
          left,
          lineHeight,
        })
      }
    }

    setBadges(next)
  }, [awareness, content, scrollTop])

  const reportCursor = () => {
    const el = textareaRef.current

    if (!el || !onCursorChange) {
      return
    }

    onCursorChange({ anchor: el.selectionStart, head: el.selectionEnd })
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (!yTextRef.current || !yDoc) {
      return
    }

    const newValue = e.target.value
    const oldValue = prevContentRef.current
    prevContentRef.current = newValue
    applyDiff(yTextRef.current, yDoc, oldValue, newValue)
    reportCursor()
  }

  if (!yDoc) {
    return <div className="doc-editor doc-editor--loading">Connecting to document…</div>
  }

  return (
    <div className="doc-editor">
      <textarea
        ref={textareaRef}
        className="doc-editor__textarea"
        value={content}
        onChange={handleChange}
        onSelect={reportCursor}
        onKeyUp={reportCursor}
        onClick={reportCursor}
        onScroll={e => setScrollTop((e.target as HTMLTextAreaElement).scrollTop)}
        disabled={disabled}
        placeholder="Start typing — changes sync across peers via Swarm…"
        spellCheck={false}
      />
      {badges.length > 0 && (
        <div className="doc-editor__cursor-overlay" aria-hidden="true">
          {badges.map(b => (
            <React.Fragment key={b.address}>
              <div
                className="doc-editor__cursor-line"
                style={{ top: b.top, left: b.left, height: b.lineHeight, background: b.color }}
              />
              <div
                className="doc-editor__cursor-badge"
                style={{ top: Math.max(0, b.top - 20), left: b.left, background: b.color }}
              >
                {b.username || b.address.slice(0, 6)}
              </div>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  )
}

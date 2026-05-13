// eslint-disable-next-line simple-import-sort/imports
import './workers' // must come before monaco-editor import

import * as monaco from 'monaco-editor'
import React, { useEffect, useRef } from 'react'
import { MonacoBinding } from 'y-monaco'
import { Doc } from 'yjs'

import { SEED } from '../../utils/yjs'

import './MonacoEditor.scss'
import { colorForAddress, injectPeerStyle } from '../../utils/peers'
import { AwarenessState } from '../../utils/types'

// TODO: style scss
const DefaultEditorOptions: monaco.editor.IStandaloneEditorConstructionOptions = {
  value: '',
  language: 'typescript',
  theme: 'vs-dark',
  automaticLayout: true,
  fontSize: 14,
  minimap: { enabled: false },
}

interface MonacoEditorProps {
  yDoc: Doc
  options?: monaco.editor.IStandaloneEditorConstructionOptions
  filePathKey?: string
  disabled?: boolean
  awareness?: Map<string, AwarenessState>
  updateCursor?: (cursor: { anchor: number; head: number } | null) => void
}

const injectedPeers = new Set<string>()

export const MonacoEditor: React.FC<MonacoEditorProps> = ({
  yDoc,
  options,
  filePathKey = SEED,
  disabled = false,
  awareness,
  updateCursor,
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const bindingRef = useRef<MonacoBinding | null>(null)
  const decorationsRef = useRef<Map<string, string[]>>(new Map())

  useEffect(() => {
    if (!containerRef.current) {
      return
    }

    editorRef.current = monaco.editor.create(containerRef.current, options ?? DefaultEditorOptions)

    return () => {
      editorRef.current?.dispose()
      editorRef.current = null
    }
  }, [options])

  useEffect(() => {
    if (!editorRef.current || !yDoc) {
      return
    }

    const yText = yDoc.getText(filePathKey)
    const model = editorRef.current.getModel()

    if (!model) {
      return
    }

    bindingRef.current = new MonacoBinding(
      yText,
      model,
      new Set([editorRef.current]),
      undefined, // TODO: review awareness in case of y-webrtc
    )

    return () => {
      bindingRef.current?.destroy()
      bindingRef.current = null
    }
  }, [yDoc, filePathKey])

  useEffect(() => {
    if (!editorRef.current || !yDoc || !updateCursor) return

    const disposable = editorRef.current.onDidChangeCursorSelection(e => {
      const model = editorRef.current?.getModel()

      if (!model) {
        return
      }

      updateCursor({
        anchor: model.getOffsetAt(e.selection.getStartPosition()),
        head: model.getOffsetAt(e.selection.getEndPosition()),
      })
    })

    return () => disposable.dispose()
  }, [yDoc, filePathKey, updateCursor])

  useEffect(() => {
    if (!awareness) {
      return
    }

    const handleAwareness = ({
      address,
      username,
      cursor,
    }: {
      address: string
      username: string
      cursor: { anchor: number; head: number } | null
    }) => {
      if (!editorRef.current) {
        return
      }

      // remove previous decorations for this peer
      const prev = decorationsRef.current.get(address) ?? []

      if (!cursor) {
        // peer left or cleared cursor
        editorRef.current.deltaDecorations(prev, [])
        decorationsRef.current.delete(address)

        return
      }

      const model = editorRef.current.getModel()

      if (!model) {
        return
      }

      // directly convert offsets to Monaco positions — no Yjs resolution needed
      const anchorPos = model.getPositionAt(cursor.anchor)
      const headPos = model.getPositionAt(cursor.head)

      // build a Range — handle both directions of selection
      const range = monaco.Range.fromPositions(anchorPos, headPos)

      const newDecorations = editorRef.current.deltaDecorations(prev, [
        // selection highlight
        {
          range,
          options: {
            className: `remote-selection-${address.slice(2, 8)}`,
            inlineClassName: `remote-selection-inline-${address.slice(2, 8)}`,
          },
        },
        // cursor line (zero-width range at head)
        {
          range: new monaco.Range(headPos.lineNumber, headPos.column, headPos.lineNumber, headPos.column),
          options: {
            className: `remote-cursor-${address.slice(2, 8)}`,
            beforeContentClassName: `remote-cursor-head-${address.slice(2, 8)}`,
          },
        },
      ])

      decorationsRef.current.set(address, newDecorations)

      const color = colorForAddress(address)
      const peerKey = address.slice(2, 8)

      if (injectedPeers.has(peerKey)) {
        return
      }

      injectedPeers.add(peerKey)
      injectPeerStyle(peerKey, address, username, color)
    }

    awareness.forEach(state => {
      handleAwareness({
        address: state.address,
        username: state.username,
        cursor: state.cursor ?? null,
      })
    })
  }, [awareness])

  return <div ref={containerRef} style={{ width: '100%', height: '600px' }} />
}

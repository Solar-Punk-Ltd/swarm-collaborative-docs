// eslint-disable-next-line simple-import-sort/imports
import './workers' // must come before monaco-editor import

import * as monaco from 'monaco-editor'
import React, { useEffect, useRef } from 'react'
import { MonacoBinding } from 'y-monaco'
import { Doc } from 'yjs'

import { SEED } from '../../utils/yjs'

import './MonacoEditor.scss'

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
  username: string
  userColor?: string
}

export const MonacoEditor: React.FC<MonacoEditorProps> = ({
  yDoc,
  options,
  filePathKey = SEED,
  // username,
  // disabled = false,
  // userColor = '#e06c75',
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const bindingRef = useRef<MonacoBinding | null>(null)

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

    const ytext = yDoc.getText(filePathKey)
    const monacoModel = editorRef.current.getModel()

    if (!monacoModel) {
      return
    }

    bindingRef.current = new MonacoBinding(
      ytext,
      monacoModel,
      new Set([editorRef.current]),
      undefined, // TODO: awareness
    )

    return () => {
      bindingRef.current?.destroy()
      bindingRef.current = null
    }
  }, [yDoc, filePathKey])

  return <div ref={containerRef} style={{ width: '100%', height: '600px' }} />
}

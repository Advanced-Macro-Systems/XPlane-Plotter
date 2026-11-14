// Drag files anywhere over the window: a full-window drop target appears; dropping opens them (session .json files
// load onto the open log). Only drags that carry files count, so dragging text or a chart inside the page does not.

import { UploadIcon } from '@primer/octicons-react'
import { useEffect, useState } from 'react'
import { openPickedFiles } from './fileActions'
import { dragHasFiles } from './shellModel'

/** Browsers repeat dragover every ~50 ms while a drag is over the page; this long without one means it left. */
const DRAG_TIMEOUT_MS = 700

export function DropOverlay() {
  const [active, setActive] = useState(false)

  useEffect(() => {
    let depth = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const hide = () => {
      depth = 0
      clearTimeout(timer)
      setActive(false)
    }
    const keepAlive = () => {
      clearTimeout(timer)
      timer = setTimeout(hide, DRAG_TIMEOUT_MS)
    }
    const onEnter = (event: DragEvent) => {
      if (!dragHasFiles(event.dataTransfer?.types)) return
      event.preventDefault()
      depth += 1
      setActive(true)
      keepAlive()
    }
    const onOver = (event: DragEvent) => {
      if (!dragHasFiles(event.dataTransfer?.types)) return
      // Without preventDefault the browser would open the file itself, replacing the app.
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      setActive(true)
      keepAlive()
    }
    const onLeave = (event: DragEvent) => {
      if (!dragHasFiles(event.dataTransfer?.types)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) hide()
    }
    const onDrop = (event: DragEvent) => {
      if (!dragHasFiles(event.dataTransfer?.types)) return
      event.preventDefault()
      hide()
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (files.length) void openPickedFiles(files)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  if (!active) return null
  return (
    <div className="sh-dropzone" aria-hidden="true">
      <div className="sh-dropzone-card">
        <span className="sh-dropzone-icon">
          <UploadIcon size={28} />
        </span>
        <p className="sh-dropzone-title">Drop to open</p>
        <p className="sh-dropzone-note">Files stay on this computer</p>
      </div>
    </div>
  )
}

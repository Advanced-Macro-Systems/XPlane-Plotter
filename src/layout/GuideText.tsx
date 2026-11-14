import { codeSegments } from './shellModel'

/** Recording-guide text with its `code` spans (header tokens) set in mono. Rendered as React text, never as HTML. */
export function GuideText({ text }: { text: string }) {
  return (
    <>
      {codeSegments(text).map((segment, i) =>
        segment.code ? <code key={i}>{segment.text}</code> : <span key={i}>{segment.text}</span>,
      )}
    </>
  )
}

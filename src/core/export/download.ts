// Saving files from the browser and copying to the clipboard.
// OWNER: export agent. Public API below is a contract; keep these signatures.
//
// Every function is safe to call outside a browser (tests, workers): without a DOM, downloads do nothing and
// copyText resolves false.

/** Spreadsheet MIME types that get a UTF-8 byte-order mark (see downloadText). */
const BOM_TYPES = /^text\/(csv|tab-separated-values)\b/i

/** How long the object URL outlives the click: some browsers only start reading the blob after click() returns. */
const REVOKE_DELAY_MS = 30_000

/** U+FEFF, the byte-order mark. */
const BOM = String.fromCharCode(0xfeff)

/**
 * Triggers a download of text (UTF-8). CSV / TSV (`text/csv`, `text/tab-separated-values`) get a UTF-8 byte-order
 * mark, without which Excel decodes the file as ANSI and mangles units such as "°", "²" or "·".
 */
export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  const type = /charset=/i.test(mime) ? mime : `${mime};charset=utf-8`
  const body = BOM_TYPES.test(mime) && !text.startsWith(BOM) ? BOM + text : text
  downloadBlob(filename, new Blob([body], { type }))
}

export function downloadBlob(filename: string, blob: Blob): void {
  if (typeof document === 'undefined' || !document.body) return
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  link.style.display = 'none'
  document.body.appendChild(link)
  try {
    link.click()
  } finally {
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS)
  }
}

/** Names Windows refuses for files, whatever the extension. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i

/** Longest stem returned: room for an extension and suffixes within every file system's limits. */
const MAX_STEM = 100

/** A safe file name stem from free text ("CG fwd / 250 kt" -> "CG_fwd_250_kt"); `fallback` when nothing is left. */
export function safeFilename(name: string, fallback = 'export'): string {
  const stem = name
    // "é" -> "e": decompose accented letters and drop the accents, so the result stays plain ASCII.
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_{2,}/g, '_')
    // No leading dots (hidden files) and no trailing dots (Windows drops them).
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, MAX_STEM)
    .replace(/[._-]+$/, '')
  if (!stem) return fallback
  return RESERVED.test(stem.split('.')[0]) ? `${stem}_` : stem
}

/** Copies text; resolves false when the clipboard is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Permission denied or not a secure context (plain http://): try the legacy path below.
  }
  return legacyCopy(text)
}

/** Copy through a hidden textarea and document.execCommand('copy') (older browsers, insecure contexts). */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body || typeof document.execCommand !== 'function') return false
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  // Off-screen but selectable (an element with display:none cannot be selected).
  area.style.position = 'fixed'
  area.style.top = '0'
  area.style.left = '-9999px'
  area.style.opacity = '0'
  const active = document.activeElement
  const focused = typeof HTMLElement !== 'undefined' && active instanceof HTMLElement ? active : null
  const selection = typeof document.getSelection === 'function' ? document.getSelection() : null
  const saved = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
  document.body.appendChild(area)
  let copied: boolean
  try {
    area.select()
    area.setSelectionRange(0, text.length)
    copied = document.execCommand('copy')
  } catch {
    copied = false
  } finally {
    area.remove()
    // Give the user back their selection and focus.
    if (saved && selection) {
      selection.removeAllRanges()
      selection.addRange(saved)
    }
    focused?.focus()
  }
  return copied
}

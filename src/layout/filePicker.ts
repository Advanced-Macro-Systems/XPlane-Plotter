// The app has ONE hidden <input type="file" data-testid="file-input"> (rendered by App). Every "Open file" action —
// header button, landing, dataset menu, recent files, Ctrl/Cmd+O — clicks it through openFilePicker().

let input: HTMLInputElement | null = null

/** Ref callback for the app's file input. */
export function registerFileInput(element: HTMLInputElement | null): void {
  input = element
}

/** Opens the browser's file chooser (no-op before the input has mounted). */
export function openFilePicker(): void {
  input?.click()
}

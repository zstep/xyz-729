const sidebarThemes = new WeakMap<Document, { style: HTMLStyleElement; owners: number }>()

/** Enable Harness's native macOS layout before its client modules mount. */
export function mountMacosWindowChrome(
  doc: Document,
  subscribe: (listener: (fullscreen: boolean) => void) => () => void
): () => void {
  let fullscreen = false
  let theme = sidebarThemes.get(doc)
  if (!theme) {
    theme = { style: doc.createElement('style'), owners: 0 }
    sidebarThemes.set(doc, theme)
  }
  theme.owners++
  const style = theme.style
  style.dataset.dshMacosSidebarTheme = ''
  // The Desktop sidebar uses Harness theme colors over the native window material.
  // This is window chrome: the host owns the transparent macOS BrowserWindow.
  // The native window keeps macOS vibrancy and paints the document transparent
  // above it. Publish the theme's sidebar fill on the one sidebar root so the
  // left rail matches the light/dark content instead of the system material
  // (which follows the system appearance, not the in-app theme).
  style.textContent = 'html[data-platform="darwin"] [data-dsh-sidebar-root] { background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #f8f8f6)) !important; }'
  const mark = (): void => {
    const root = doc.documentElement
    if (!root) return
    // Keyboard detection stays on Harness's desktop runtime; this chrome
    // helper never opts the host into the browser shortcut adapter.
    if (!style.isConnected && doc.head) doc.head.append(style)
    root.dataset.platform = 'darwin'
    if (fullscreen) root.dataset.fullscreen = 'true'
    else delete root.dataset.fullscreen
  }
  mark()
  doc.addEventListener('DOMContentLoaded', mark, { once: true })
  const unsubscribe = subscribe(value => {
    fullscreen = value
    mark()
  })
  return () => {
    doc.removeEventListener('DOMContentLoaded', mark)
    unsubscribe()
    if (--theme.owners === 0) { style.remove(); sidebarThemes.delete(doc) }
  }
}

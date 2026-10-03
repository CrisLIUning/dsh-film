/**
 * The Host's current look, read from the page the Host themes: the color
 * scheme on the root element and the resolved alias tokens on the body. The
 * hosted apps receive it so they can match the Host instead of carrying a
 * look of their own.
 */

/** Alias tokens forwarded to the hosted apps. */
const FORWARDED_TOKENS = [
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-label-caption',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l3',
  '--dsw-alias-brand-primary',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsh-content-font-size',
] as const

export interface HostTheme {
  scheme: 'light' | 'dark'
  /** Resolved values of the forwarded tokens; unset tokens are left out. */
  tokens: Record<string, string>
  fontFamily: string
}

/**
 * Read the Host's look now.
 * @returns the scheme, tokens and font.
 */
export function readHostTheme(): HostTheme {
  const root = document.documentElement
  const declared = root.style.colorScheme
  const scheme = declared === 'dark' || declared === 'light'
    ? declared
    : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  const style = getComputedStyle(document.body)
  const tokens: Record<string, string> = {}
  for (const name of FORWARDED_TOKENS) {
    const value = style.getPropertyValue(name).trim()
    if (value !== '') tokens[name] = value
  }
  return { scheme, tokens, fontFamily: style.fontFamily }
}

/**
 * Call back whenever the Host's look may have changed: the Host rewrites the
 * root's color scheme and the body's token variables on every theme change.
 * @param listener - called with the new look.
 * @returns stops observing.
 */
export function observeHostTheme(listener: (theme: HostTheme) => void): () => void {
  let last = JSON.stringify(readHostTheme())
  const check = (): void => {
    const theme = readHostTheme()
    const serialized = JSON.stringify(theme)
    if (serialized === last) return
    last = serialized
    listener(theme)
  }
  const observer = new MutationObserver(check)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme-source'] })
  observer.observe(document.body, { attributes: true, attributeFilter: ['style', 'data-dark', 'class'] })
  const media = matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener('change', check)
  return () => {
    observer.disconnect()
    media.removeEventListener('change', check)
  }
}

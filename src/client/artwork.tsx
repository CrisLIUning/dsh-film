/**
 * Guide artwork for the three parts, drawn like the Host's own guide artwork:
 * a 36px fixed-palette canvas, hidden from assistive technology.
 */

/** The props the guide passes an entry's icon. */
export interface ArtworkProps {
  size?: number | undefined
  className?: string | undefined
}

/**
 * The script part: a page with lines.
 * @param props - canvas size and layout class.
 * @returns the artwork.
 */
export function ArtworkStory({ size = 36, className }: ArtworkProps) {
  return (
    <svg width={size} height={size} className={className} aria-hidden="true" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M11 7.5H21.5L26.5 12.5V27C26.5 27.83 25.83 28.5 25 28.5H11C10.17 28.5 9.5 27.83 9.5 27V9C9.5 8.17 10.17 7.5 11 7.5Z" stroke="#F28B5B" strokeWidth="2" strokeLinejoin="round" />
      <path d="M21 7.5V13H26.5" stroke="#F28B5B" strokeWidth="2" strokeLinejoin="round" />
      <path d="M13.5 17.5H22.5M13.5 21.5H22.5M13.5 25.5H18.5" stroke="#F8B48F" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

/**
 * The storyboard part: linked shot cards.
 * @param props - canvas size and layout class.
 * @returns the artwork.
 */
export function ArtworkBoard({ size = 36, className }: ArtworkProps) {
  return (
    <svg width={size} height={size} className={className} aria-hidden="true" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="6" y="8" width="11" height="8.5" rx="1.5" fill="#7C8CF8" />
      <rect x="20" y="9" width="10" height="7.5" rx="1.5" stroke="#7C8CF8" strokeWidth="2" />
      <rect x="13" y="21" width="10" height="7.5" rx="1.5" stroke="#7C8CF8" strokeWidth="2" />
      <path d="M11.5 16.5V19H18V21M25 16.5V19H18" stroke="#B3BCFB" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * The director desk: a film camera.
 * @param props - canvas size and layout class.
 * @returns the artwork.
 */
export function ArtworkDirector({ size = 36, className }: ArtworkProps) {
  return (
    <svg width={size} height={size} className={className} aria-hidden="true" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="6.5" y="14" width="16" height="12" rx="2" stroke="#E5679B" strokeWidth="2" />
      <path d="M22.5 18L29.5 14.5V25.5L22.5 22" stroke="#E5679B" strokeWidth="2" strokeLinejoin="round" />
      <circle cx="10.5" cy="9.5" r="3" fill="#F2A7C6" />
      <circle cx="18" cy="9.5" r="3" fill="#F2A7C6" />
    </svg>
  )
}

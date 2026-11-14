/** The app mark (public/favicon.svg): a trace over a baseline on Bristol red. Decorative: the title names the app. */
export function LogoMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="7" fill="#ab1f2d" />
      <path
        d="M5 21.5c2.6 0 3.4-9 6-9s3.2 6.5 5.6 6.5S20 8 23 8s2.6 7.5 4 7.5"
        fill="none"
        stroke="#fff"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M5 26h22" stroke="#fff" strokeOpacity=".55" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

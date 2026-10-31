import React from 'react'

export interface MisakaLogoProps {
  size?: number
  className?: string
}

export const MisakaLogo: React.FC<MisakaLogoProps> = ({
  size = 32,
  className = '',
}) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 480 480"
      width={size}
      height={size}
      className={`shrink-0 select-none ${className}`}
      aria-label="Misaka Agent Logo"
    >
      <rect width="480" height="480" rx="108" fill="var(--accent)" />
      <circle cx="240" cy="244.13" r="115.98" fill="var(--on-accent)" />
      <circle cx="240" cy="157.12" r="29.10" fill="var(--accent)" />
      <circle cx="240" cy="293.44" r="72.62" fill="var(--accent)" />
    </svg>
  )
}

export default MisakaLogo

import React, { useId } from "react";

// Lead FMS mark — a phone handset with a small "signal" arc, on a rose tile.
// Matches the rose accent used inside the Lead FMS app. Pure SVG.
export default function LeadsLogo({ size = 34, className = "" }) {
  const uid = useId().replace(/:/g, "");
  return (
    <svg className={"logo " + className} width={size} height={size} viewBox="0 0 48 48" role="img" aria-label="Lead FMS">
      <defs>
        <linearGradient id={`ld-bg-${uid}`} x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#6d5bf0" />
          <stop offset="1" stopColor="#2a5fd6" />
        </linearGradient>
        <linearGradient id={`ld-shine-${uid}`} x1="0" y1="0" x2="0" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity=".24" />
          <stop offset=".55" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="14" fill={`url(#ld-bg-${uid})`} />
      <rect width="48" height="48" rx="14" fill={`url(#ld-shine-${uid})`} />
      <rect x=".75" y=".75" width="46.5" height="46.5" rx="13.25" fill="none" stroke="#fff" strokeOpacity=".2" strokeWidth="1.5" />
      {/* handset */}
      <path
        d="M17.2 12.5c-.6-.9-1.8-1.1-2.7-.5l-2 1.4c-1 .7-1.4 1.9-1.1 3 1.6 6.7 6.1 12.2 12.1 15.7 1.4.8 3 1.1 4.500.7l2.600-.7c1.100-.3 1.800-1.400 1.600-2.500l-.500-2.200c-.200-.9-1-1.500-1.900-1.400l-2.700.4c-.5.1-1.100-.1-1.500-.5l-3.600-3.600c-.4-.4-.6-1-.5-1.500l.4-2.500c.1-.9-.3-1.800-1.100-2.200l-2.400-1.500Z"
        fill="#fff" fillOpacity=".95" transform="translate(1 2)"
      />
      {/* signal arcs */}
      <path d="M29 12.500a9 9 0 0 1 7.500 7.500M29 17.500a4.500 4.500 0 0 1 3.500 3.500" fill="none" stroke="#fff" strokeWidth="2.800" strokeLinecap="round" />
    </svg>
  );
}

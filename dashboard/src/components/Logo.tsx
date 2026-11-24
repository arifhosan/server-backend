export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
      <rect x="1" y="1" width="26" height="26" rx="7" fill="#1C2029" stroke="#5B9BFF" strokeWidth="1.5" />
      <path
        d="M8 17v-6M11 14H5M17 13h.01M20 16h.01"
        stroke="#E8EAEE"
        strokeWidth="2"
        strokeLinecap="round"
        transform="translate(2 0)"
      />
    </svg>
  );
}

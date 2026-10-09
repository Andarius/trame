// inline SVG with hardcoded colors — the span version relied on the --color-copper
// var and color-mix opacity, one of which the Linux WebKitGTK webview drops (logo
// rendered invisible). SVG with literal hex is bulletproof across both webviews.
export function LogoMark() {
  return (
    <svg
      width="26"
      height="26"
      viewBox="0 0 26 26"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect width="26" height="26" rx="7" fill="#c98a63" />
      <rect
        x="6"
        y="11"
        width="14"
        height="3.5"
        rx="1.75"
        fill="#120e0b"
        fillOpacity="0.85"
      />
      <rect
        x="11.5"
        y="6"
        width="3.5"
        height="14"
        rx="1.75"
        fill="#120e0b"
        fillOpacity="0.55"
      />
    </svg>
  );
}

export function GroupIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <rect x="2" y="2.5" width="12" height="4" rx="1" />
      <rect x="2" y="9.5" width="12" height="4" rx="1" />
    </svg>
  );
}

// inline SVG (not a glyph): the Unicode gear renders as a colored emoji on WKWebView
// and as tofu with the FE0E text selector on WebKitGTK — neither is acceptable
export function GearIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

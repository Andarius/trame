import type { ReactNode } from "react";

// inline SVG with hardcoded colors — the span version relied on the --color-copper
// var and color-mix opacity, one of which the Linux WebKitGTK webview drops (logo
// rendered invisible). SVG with literal hex is bulletproof across both webviews.
// debug builds get a blue mark so a dev window can't pass for the installed app
export function LogoMark({ debug = false }: { debug?: boolean }) {
  return (
    <svg
      width="26"
      height="26"
      viewBox="0 0 26 26"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect width="26" height="26" rx="7" fill={debug ? "#5b8fd6" : "#c98a63"} />
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

// `right`: the panel on the right (the docked card details)
export function SidebarIcon({ size = 15, right = false }: { size?: number; right?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <path d={right ? "M10 2.75v10.5" : "M6 2.75v10.5"} />
    </svg>
  );
}

export function ChartIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M2 13.5h12" />
      <path d="M4.5 11V8" />
      <path d="M8 11V4" />
      <path d="M11.5 11V6.5" />
    </svg>
  );
}

export function TimelineIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M2.5 4h6" />
      <path d="M5.5 8h7" />
      <path d="M4 12h5" />
    </svg>
  );
}

export function GroupIcon() {
  return (
    <svg
      width="15"
      height="15"
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

// two sliders: a list's view options (grouping)
export function SlidersIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M5 2v6.2M5 11.8V14M11 2v1.7M11 7.3V14" />
      <circle cx="5" cy="10" r="1.8" />
      <circle cx="11" cy="5.5" r="1.8" />
    </svg>
  );
}

// a shell prompt: ›_ drawn, since the glyphs render tiny on WebKitGTK
export function TerminalIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" strokeWidth="1.2" />
      <path d="M4.5 6l2 2-2 2M8.5 10.5h3" />
    </svg>
  );
}

// a pull request: two branches merging
export function PrIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      <circle cx="4" cy="3.5" r="1.5" />
      <circle cx="4" cy="12.5" r="1.5" />
      <circle cx="12" cy="12.5" r="1.5" />
      <path d="M4 5v6M12 11V7a2 2 0 0 0-2-2H7.5M9 3.5 7.5 5 9 6.5" />
    </svg>
  );
}

// terminal dock toolbar
function DockSvg({ size, children }: { size: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}
export const SplitRightIcon = ({ size = 16 }: { size?: number }) => (
  <DockSvg size={size}>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
    <path d="M8 2.75v10.5" />
  </DockSvg>
);
export const SplitDownIcon = ({ size = 16 }: { size?: number }) => (
  <DockSvg size={size}>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
    <path d="M1.75 8h12.5" />
  </DockSvg>
);
export const MaximizeIcon = ({ size = 16, restore = false }: { size?: number; restore?: boolean }) => (
  <DockSvg size={size}>
    {restore
      ? <path d="M6.5 2.5v4h-4M9.5 13.5v-4h4M6.5 6.5 2 2M9.5 9.5 14 14" />
      : <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />}
  </DockSvg>
);
export const ChevronIcon = ({ size = 16, up = false }: { size?: number; up?: boolean }) => (
  <DockSvg size={size}>
    <path d={up ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4"} />
  </DockSvg>
);
export const PlusIcon = ({ size = 16 }: { size?: number }) => (
  <DockSvg size={size}>
    <path d="M8 3v10M3 8h10" />
  </DockSvg>
);

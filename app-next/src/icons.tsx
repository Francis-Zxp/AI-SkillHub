export type IconName =
  | "add"
  | "agent"
  | "alert"
  | "chevron"
  | "copy"
  | "dashboard"
  | "download"
  | "edit"
  | "exitFullscreen"
  | "fullscreen"
  | "github"
  | "globe"
  | "info"
  | "library"
  | "list"
  | "moon"
  | "more"
  | "refresh"
  | "search"
  | "settings"
  | "shield"
  | "snapshots"
  | "sources"
  | "sparkle"
  | "sun"
  | "trash"
  | "workspaces";

export function Icon({ className = "", name }: { className?: string; name: IconName }) {
  const props = {
    className: `ui-icon ${className}`.trim(),
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.7,
    viewBox: "0 0 24 24",
    "aria-hidden": true
  };

  switch (name) {
    case "add":
      return <svg {...props}><path d="M12 5v14M5 12h14" /></svg>;
    case "agent":
      return <svg {...props}><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2.5" /><path d="M12 3v2M21 12h-2M12 21v-2M3 12h2" /></svg>;
    case "alert":
      return <svg {...props}><path d="M12 4 21 20H3L12 4Z" /><path d="M12 10v4M12 17h.01" /></svg>;
    case "chevron":
      return <svg {...props}><path d="m9 6 6 6-6 6" /></svg>;
    case "copy":
      return <svg {...props}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" transform="translate(2 2)" /></svg>;
    case "dashboard":
      return <svg {...props}><rect x="4" y="4" width="6" height="6" rx="1.5" /><rect x="14" y="4" width="6" height="6" rx="1.5" /><rect x="4" y="14" width="6" height="6" rx="1.5" /><rect x="14" y="14" width="6" height="6" rx="1.5" /></svg>;
    case "download":
      return <svg {...props}><path d="M12 3v12" /><path d="m7.5 10.5 4.5 4.5 4.5-4.5" /><path d="M5 20h14" /></svg>;
    case "edit":
      return <svg {...props}><path d="M4 20h4L19 9l-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></svg>;
    case "exitFullscreen":
      return <svg {...props}><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></svg>;
    case "fullscreen":
      return <svg {...props}><path d="M8 4H4v4M16 4h4v4M8 20H4v-4M16 20h4v-4" /></svg>;
    case "github":
      return (
        <svg {...props} fill="currentColor" stroke="none">
          <path d="M12 2.7a9.5 9.5 0 0 0-3 18.5c.5.1.7-.2.7-.5v-1.9c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 0 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.4-1.1.6-1.3-2.3-.3-4.6-1.1-4.6-4.7 0-1 .4-1.9 1-2.6-.1-.3-.4-1.3.1-2.6 0 0 .8-.3 2.7 1a9.3 9.3 0 0 1 4.9 0c1.9-1.3 2.7-1 2.7-1 .5 1.3.2 2.3.1 2.6.7.7 1 1.6 1 2.6 0 3.6-2.3 4.4-4.6 4.7.4.3.7 1 .7 1.9v2.8c0 .3.2.6.7.5A9.5 9.5 0 0 0 12 2.7Z" />
        </svg>
      );
    case "globe":
      return <svg {...props}><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a13.4 13.4 0 0 1 0 18a13.4 13.4 0 0 1 0-18Z" /></svg>;
    case "info":
      return <svg {...props}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>;
    case "library":
      return <svg {...props}><path d="M6 4h10a2 2 0 0 1 2 2v14H8a2 2 0 0 1-2-2V4Z" /><path d="M8 18h10M9 8h6M9 12h5" /></svg>;
    case "list":
      return <svg {...props}><path d="M8 6h12M8 12h12M8 18h12" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></svg>;
    case "moon":
      return <svg {...props}><path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 7 7 0 1 0 20 15.5Z" /></svg>;
    case "more":
      return <svg {...props}><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></svg>;
    case "refresh":
      return <svg {...props}><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /><path d="M3 12A9 9 0 0 1 18 5.3L21 8" /><path d="M21 3v5h-5" /></svg>;
    case "search":
      return <svg {...props}><circle cx="11" cy="11" r="7" /><path d="m16.5 16.5 3.5 3.5" /></svg>;
    case "settings":
      return <svg {...props}><circle cx="12" cy="12" r="3.1" /><path d="M12 2.8 13.7 5a7.6 7.6 0 0 1 2.6 1.1l2.8-.6 1.7 3-1.9 2.1a7.7 7.7 0 0 1 0 2.8l1.9 2.1-1.7 3-2.8-.6a7.6 7.6 0 0 1-2.6 1.1L12 21.2 10.3 19a7.6 7.6 0 0 1-2.6-1.1l-2.8.6-1.7-3 1.9-2.1a7.7 7.7 0 0 1 0-2.8L3.2 8.5l1.7-3 2.8.6A7.6 7.6 0 0 1 10.3 5L12 2.8Z" /></svg>;
    case "shield":
      return <svg {...props}><path d="M12 3 5 6v5c0 4.6 3 8 7 10 4-2 7-5.4 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></svg>;
    case "snapshots":
      return <svg {...props}><path d="m12 3 9 9-9 9-9-9 9-9Z" /><path d="m12 8 4 4-4 4-4-4 4-4Z" /></svg>;
    case "sources":
      return <svg {...props}><rect x="5" y="4" width="14" height="16" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></svg>;
    case "sparkle":
      return <svg {...props}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" /><path d="m18 15 .7 2.3L21 18l-2.3.7L18 21l-.7-2.3L15 18l2.3-.7L18 15Z" /></svg>;
    case "sun":
      return <svg {...props}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>;
    case "trash":
      return <svg {...props}><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13" /><path d="M10 11v5M14 11v5" /></svg>;
    case "workspaces":
      return <svg {...props}><circle cx="6" cy="6" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="18" r="2" /><path d="M8 6h8M6 8v8M18 8v8M8 18h8" /></svg>;
  }
}

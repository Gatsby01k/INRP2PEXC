/**
 * The workspace's glyphs, drawn in the mark's own language ("node and arc"): 1.8px strokes on a 24px grid with round
 * joins; a ring is always broken, as the mark's ring is, and a glyph carries one node in the mark's orange (`ix-node`,
 * recoloured by `--node` where it sits on colour). Drawn in `currentColor` and never carrying meaning alone — every one
 * sits beside words that say the same thing.
 */
const base = {
  width: 24,
  height: 24,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
};

type IconProps = { className?: string | undefined };

export const BellIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M6.2 9.2a5.8 5.8 0 0 1 11.6 0c0 5.4 2.2 7 2.2 7H4s2.2-1.6 2.2-7z" />
    <circle className="ix-node" cx="12" cy="19.6" r="1.9" />
  </svg>
);

export const InfoIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M12 4A8 8 0 1 0 17.66 6.34" />
    <path d="M12 11.4v4.8" />
    <circle className="ix-node" cx="12" cy="8" r="1.4" />
  </svg>
);

export const ArrowIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M4.5 12h14" />
    <path d="M13.5 6.5 19 12l-5.5 5.5" />
  </svg>
);

export const BankIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M4.2 9.9 12 4.4l7.8 5.5z" />
    <path d="M6.6 12.6v4.4M12 12.6v4.4M17.4 12.6v4.4" />
    <path d="M4.2 19.6h15.6" />
    <circle className="ix-node" cx="12" cy="7.8" r="1.3" />
  </svg>
);

export const WalletIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <rect x="3.5" y="6" width="17" height="13" rx="3.2" />
    <path d="M3.5 10.2h17" />
    <circle className="ix-node" cx="16.4" cy="14.7" r="1.9" />
  </svg>
);

export const ReceiptIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M6.5 3.8h11A1.5 1.5 0 0 1 19 5.3v14.9l-2.6-1.6-2.2 1.6-2.2-1.6-2.2 1.6-2.2-1.6L5 20.2V5.3a1.5 1.5 0 0 1 1.5-1.5z" />
    <path d="M12.5 8.6H16M8.4 12.6H16" />
    <circle className="ix-node" cx="9" cy="8.6" r="1.5" />
  </svg>
);

export const ChevronIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="m9.5 6 6 6-6 6" />
  </svg>
);

export const CheckIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="m5 12.6 4.4 4.4L19 7.4" />
  </svg>
);

/** History: the mark's broken ring as a dial, its hand from the hub. */
export const ClockIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M12 4A8 8 0 1 0 17.66 6.34" />
    <path d="M12 8v4l2.7 2.1" />
    <circle className="ix-node" cx="15.3" cy="4.7" r="1.7" />
  </svg>
);

export const PauseIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M12 3.5A8.5 8.5 0 1 0 18.01 6" />
    <path d="M10 9.5v5M14 9.5v5" />
    <circle className="ix-node" cx="15.9" cy="4.5" r="1.6" />
  </svg>
);

export const ShieldIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M12 3.4l7 2.7v5.5c0 4.3-2.7 7.5-7 9.2-4.3-1.7-7-4.9-7-9.2V6.1l7-2.7z" />
    <path className="ix-accent" d="m8.9 11.7 2.2 2.3 4-4.4" />
  </svg>
);

export const PlusIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const CloseIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />
  </svg>
);

export const MoreIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <circle cx="6" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="18" cy="12" r="1.2" fill="currentColor" stroke="none" />
  </svg>
);

export const ChevronDownIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="m6 9.5 6 6 6-6" />
  </svg>
);

export const BackIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M19 12H6" />
    <path d="m11 7-5 5 5 5" />
  </svg>
);

export const LockIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <rect x="5.2" y="10.4" width="13.6" height="9.8" rx="3" />
    <path d="M8.4 10.4V8.1a3.6 3.6 0 0 1 7.2 0v2.3" />
    <circle className="ix-node" cx="12" cy="15.3" r="1.9" />
  </svg>
);

export const PhoneIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <rect x="7" y="3" width="10" height="18" rx="2.8" />
    <circle className="ix-node" cx="12" cy="17.4" r="1.4" />
  </svg>
);

export const UserIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <circle cx="12" cy="8.4" r="3.4" />
    <path d="M5.2 19.6c.7-3.6 3.3-5.6 6.8-5.6s6.1 2 6.8 5.6" />
  </svg>
);

export const UsersIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <circle cx="9" cy="8.2" r="3.1" />
    <path d="M3.2 19.4c.5-3.3 2.8-5.2 5.8-5.2s5.3 1.9 5.8 5.2" />
    <path d="M16.4 14.5c2.4.2 4 1.9 4.5 4.9" />
    <circle className="ix-node" cx="17.2" cy="9.3" r="2.3" />
  </svg>
);

export const SignOutIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M14 4.5H7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h7" />
    <path d="M13 12h7M16.5 8.5 20 12l-3.5 3.5" />
    <circle className="ix-node" cx="10.6" cy="12" r="1.8" />
  </svg>
);

export const DownloadIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M12 7.2V15M7.5 10.5 12 15l4.5-4.5" />
    <path d="M5 19.5h14" />
    <circle className="ix-node" cx="12" cy="4.8" r="1.7" />
  </svg>
);

export const CopyIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <rect x="8.6" y="8.6" width="11" height="11" rx="2.8" />
    <path d="M5 14.6V7.4A2.4 2.4 0 0 1 7.4 5h7.2" />
  </svg>
);

export const PasteIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M15 5.5h2a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2h2" />
    <path d="M9.5 4.2h5v2.6h-5z" />
    <circle className="ix-node" cx="12" cy="13.6" r="1.8" />
  </svg>
);

export const ArchiveIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <rect x="3.5" y="4.5" width="17" height="4.5" rx="1.4" />
    <path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9" />
    <circle className="ix-node" cx="12" cy="13.6" r="1.7" />
  </svg>
);

/** Exchange: two arcs of the mark's ring turning into each other, a node where each one starts. */
export const SwapIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M6.6 8.5h12" />
    <path d="m15 5 3.5 3.5L15 12" />
    <path d="M17.4 15.5h-12" />
    <path d="M9 12l-3.5 3.5L9 19" />
    <circle className="ix-node" cx="4.6" cy="8.5" r="1.7" />
    <circle className="ix-ink" cx="19.4" cy="15.5" r="1.5" />
  </svg>
);

export const SparkIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M12 3.5c.6 4.4 2.1 5.9 6.5 6.5-4.4.6-5.9 2.1-6.5 6.5-.6-4.4-2.1-5.9-6.5-6.5 4.4-.6 5.9-2.1 6.5-6.5z" />
    <circle className="ix-node" cx="18.2" cy="18.2" r="1.8" />
  </svg>
);

/** A desk: the mark's hub with its three spokes to the parties of a deal. */
export const StoreIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M4 9.5 5.5 4.5h13L20 9.5" />
    <path d="M4 9.5a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0" />
    <path d="M5.5 12v7.5h13V12" />
    <circle className="ix-node" cx="12" cy="16.2" r="1.9" />
  </svg>
);

export const LinkIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    <circle className="ix-node" cx="12" cy="12" r="1.5" />
  </svg>
);

export const ShareIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M12 15V7.2" />
    <path d="m8.6 9.6 3.4-3.4 3.4 3.4" />
    <path d="M6 12v6.5A1.5 1.5 0 0 0 7.5 20h9a1.5 1.5 0 0 0 1.5-1.5V12" />
    <circle className="ix-node" cx="12" cy="4" r="1.7" />
  </svg>
);

export const ChatIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M5.2 5h13.6a2.7 2.7 0 0 1 2.7 2.7v7.1a2.7 2.7 0 0 1-2.7 2.7h-6.4L8 21v-3.5H5.2a2.7 2.7 0 0 1-2.7-2.7V7.7A2.7 2.7 0 0 1 5.2 5z" />
    <circle className="ix-node" cx="8.4" cy="11.3" r="1.4" />
    <circle className="ix-ink" cx="12" cy="11.3" r="1.1" />
    <circle className="ix-ink" cx="15.6" cy="11.3" r="1.1" />
  </svg>
);

export const SendIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M20.6 3.4 3.6 9.9l6.6 3.5 3.5 6.6 6.9-16.6z" />
    <path d="m10.2 13.4 4.2-4.2" />
  </svg>
);

export const ChartIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M4 20h16" />
    <path d="M7 16v-5" />
    <path d="M12 16V9.4" />
    <path d="M17 16v-8" />
    <circle className="ix-node" cx="12" cy="6.4" r="1.8" />
  </svg>
);

export const TagIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M3.5 12.3V4.5a1 1 0 0 1 1-1h7.8l8.2 8.2a1 1 0 0 1 0 1.4l-7.8 7.8a1 1 0 0 1-1.4 0Z" />
    <circle className="ix-node" cx="8" cy="8" r="1.7" />
  </svg>
);

export const PlaneIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M21 4 3 11.2l6.3 2.3L18 7.5l-6.6 7.4.4 5.6 3.2-4.1 4.3 3.1Z" />
  </svg>
);

export const SearchIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M15.67 6.33A6.6 6.6 0 1 0 17.6 11" />
    <path d="m15.9 15.9 4 4" />
    <circle className="ix-node" cx="17.1" cy="8.5" r="1.6" />
  </svg>
);

/** Today: three arcs of the mark's ring as a dial, the needle on the hub. */
export const GaugeIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M4.2 17.5a8.5 8.5 0 0 1 12.4-11.3" />
    <path d="M19.2 9.4a8.5 8.5 0 0 1 .6 8.1" />
    <path d="m12 13.5 3.5-3.5" />
    <circle className="ix-node" cx="12" cy="13.5" r="1.9" />
    <circle className="ix-ink" cx="18.2" cy="7.6" r="1.3" />
  </svg>
);

/** A deal: two sides moving against each other, each from its own node. */
export const DealsIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M10 7h9.5M10 12h9.5M10 17h6" />
    <circle className="ix-node" cx="5.4" cy="7" r="2" />
    <circle cx="5.4" cy="12" r="1.5" />
    <circle cx="5.4" cy="17" r="1.5" />
  </svg>
);

export const GlobeIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M12 3.5A8.5 8.5 0 1 0 20.5 12" />
    <path d="M3.5 12h17" />
    <path d="M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5S9.7 5.9 12 3.5Z" />
    <circle className="ix-node" cx="18.4" cy="5.6" r="1.8" />
  </svg>
);

export const MailIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <rect x="3.5" y="5.5" width="17" height="13" rx="2.8" />
    <path d="m4.5 7 6.2 5" />
    <path d="m19.5 7-6.2 5" />
    <circle className="ix-node" cx="12" cy="13" r="1.6" />
  </svg>
);

export const BoltIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M13.2 3.4 5.6 13.2h5.6l-.9 7.4 7.9-10.2h-5.7l.7-7z" />
  </svg>
);

/** Escrow: a vault that holds what is owed until it is released. */
export const VaultIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M12 3.4l7 2.7v5.5c0 4.3-2.7 7.5-7 9.2-4.3-1.7-7-4.9-7-9.2V6.1l7-2.7z" />
    <path d="M12 12.8v2.6" />
    <circle className="ix-node" cx="12" cy="10.7" r="2" />
  </svg>
);

export const TrendIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="m3.5 16.5 5.5-5.5 4 4 5.6-5.6" />
    <circle className="ix-node" cx="20.2" cy="7.8" r="2" />
  </svg>
);

export const ArrowUpRightIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M7 17 17 7" />
    <path d="M8.5 7H17v8.5" />
  </svg>
);

export const ArrowDownLeftIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M17 7 7 17" />
    <path d="M15.5 17H7V8.5" />
  </svg>
);

export const InboxIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M4 13.5 6.3 5.6a1.5 1.5 0 0 1 1.4-1.1h8.6a1.5 1.5 0 0 1 1.4 1.1l2.3 7.9" />
    <path d="M4 13.5v5a1.5 1.5 0 0 0 1.5 1.5h13a1.5 1.5 0 0 0 1.5-1.5v-5h-4.5l-1.5 2.5h-4L8.5 13.5Z" />
    <circle className="ix-node" cx="12" cy="9.2" r="1.7" />
  </svg>
);

export const HelpIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M12 3.5A8.5 8.5 0 1 0 18.01 6" />
    <path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.7" />
    <circle className="ix-node" cx="12" cy="17" r="1.3" />
    <circle className="ix-ink" cx="15.9" cy="4.5" r="1.2" />
  </svg>
);

export const SettingsIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M4 7h8.6M17.4 7H20M4 17h2.6M11.4 17H20" />
    <circle className="ix-node" cx="15" cy="7" r="2.2" />
    <circle cx="9" cy="17" r="2.2" />
  </svg>
);

export const KeyIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <circle cx="8" cy="15" r="4.2" />
    <path d="m11 12 8.5-8.5M16.5 6.5l2.5 2.5M14 9l2 2" />
    <circle className="ix-node" cx="8" cy="15" r="1.5" />
  </svg>
);

export const CalendarIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <rect x="4" y="5.5" width="16" height="14.5" rx="2.8" />
    <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
    <circle className="ix-node" cx="15.5" cy="15" r="1.6" />
  </svg>
);

export const ExternalIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M13.5 4.5h6v6M19.5 4.5 11 13" />
    <path d="M17.5 14v4a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V8A1.5 1.5 0 0 1 6 6.5h4" />
  </svg>
);

export const QrIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <rect x="4" y="4" width="6" height="6" rx="1.4" />
    <rect x="14" y="4" width="6" height="6" rx="1.4" />
    <rect x="4" y="14" width="6" height="6" rx="1.4" />
    <path d="M14 14h2.5v2.5M17 20h3v-3" />
    <circle className="ix-node" cx="14.6" cy="19.4" r="1.3" />
  </svg>
);

export const SunIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <circle cx="12" cy="12" r="3.8" />
    <path d="M12 3v1.8M12 19.2V21M3 12h1.8M19.2 12H21M5.6 5.6l1.3 1.3M17.1 17.1l1.3 1.3M5.6 18.4l1.3-1.3M17.1 6.9l1.3-1.3" />
  </svg>
);

export const MoonIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M19.5 14.2A7.8 7.8 0 0 1 9.8 4.5a7.8 7.8 0 1 0 9.7 9.7Z" />
  </svg>
);

export const ReturnIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M19 5.5v6a2.5 2.5 0 0 1-2.5 2.5H6" />
    <path d="m9.5 10.5-3.5 3.5 3.5 3.5" />
  </svg>
);

export const GridIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <rect x="4" y="4" width="6.5" height="6.5" rx="1.8" />
    <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.8" />
    <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.8" />
    <circle className="ix-node" cx="16.75" cy="16.75" r="3" />
  </svg>
);

export const PaperclipIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="m19.6 11.2-7.9 7.9a4.9 4.9 0 0 1-6.9-6.9l8.3-8.3a3.2 3.2 0 0 1 4.6 4.6l-8.2 8.2a1.6 1.6 0 0 1-2.3-2.3l7.5-7.5" />
  </svg>
);

export const TimerIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M12 5.2A7.6 7.6 0 1 0 17.4 7.4" />
    <path d="M12 9v3.8l2.4 1.9" />
    <path d="M10 2.6h4" />
    <circle className="ix-node" cx="15.1" cy="5.9" r="1.6" />
  </svg>
);

/** A party the platform has checked: a seal with a tick. */
export const VerifiedIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M12 3.2 14.2 5l2.8-.3.9 2.7 2.4 1.5-1 2.6 1 2.6-2.4 1.5-.9 2.7-2.8-.3L12 20.8 9.8 19l-2.8.3-.9-2.7-2.4-1.5 1-2.6-1-2.6 2.4-1.5.9-2.7 2.8.3Z" />
    <path className="ix-accent" d="m9 12 2 2 4-4" />
  </svg>
);

export const AlertIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M12 4.2l8.3 14.2a1 1 0 0 1-.9 1.6H4.6a1 1 0 0 1-.9-1.6L12 4.2z" />
    <path d="M12 10v4.3" />
    <circle className="ix-node" cx="12" cy="17.1" r="1.3" />
  </svg>
);

export const RefreshIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M19.5 12a7.5 7.5 0 0 1-12.4 5.7" />
    <path d="M4.5 12a7.5 7.5 0 0 1 12.4-5.7" />
    <circle className="ix-node" cx="18.4" cy="7.4" r="2" />
    <circle className="ix-ink" cx="5.6" cy="16.6" r="1.6" />
  </svg>
);

/** The direction of a trade: a down-and-up pair for "both ways". */
export const ArrowsUpDownIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M8 19.5V5" />
    <path d="m4.5 8.5 3.5-3.5 3.5 3.5" />
    <path d="M16 4.5V19" />
    <path d="m19.5 15.5-3.5 3.5-3.5-3.5" />
  </svg>
);

/** The Exchange: two arcs chasing each other, a node leading each — the mark's ring, turning. */
export const ExchangeIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M4.4 10.2A7.8 7.8 0 0 1 16.9 5.9" />
    <path d="M19.6 13.8A7.8 7.8 0 0 1 7.1 18.1" />
    <circle className="ix-node" cx="19" cy="8.6" r="2.1" />
    <circle className="ix-ink" cx="5" cy="15.4" r="1.7" />
  </svg>
);

/** Desks: the mark's hub and its three spokes — independent desks on one network. */
export const DesksIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M12 9.9V6.7M10 13.6l-3 1.9M14 13.6l3 1.9" />
    <circle cx="12" cy="4.6" r="2" />
    <circle cx="5.2" cy="16.8" r="2" />
    <circle cx="18.8" cy="16.8" r="2" />
    <circle className="ix-node" cx="12" cy="12.3" r="2.4" />
  </svg>
);

/** History: a clock whose ring opens to the past. */
export const HistoryIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M4.5 9.2A8 8 0 1 1 4.5 14.8" />
    <path d="M12 7.6V12l3 1.8" />
    <circle className="ix-node" cx="4" cy="12" r="1.9" />
  </svg>
);

/** A rate: the rupee inside the broken ring. */
export const RateIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M17.66 6.34A8 8 0 1 0 20 12" />
    <path transform="translate(12 12.3) scale(.78) translate(-12 -12.3)" d="M8.5 7.5h7M8.5 10.5h7M10 7.5c2.6 0 3.9 1.1 3.9 2.9 0 1.9-1.4 3-3.9 3H9l4.8 3.6" />
    <circle className="ix-node" cx="19.4" cy="8.9" r="1.7" />
  </svg>
);

/** Support: the robot's own headphones. */
export const SupportIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M4.8 13.4V12a7.2 7.2 0 0 1 14.4 0v1.4" />
    <path d="M19.2 18.4c0 1.7-1.9 2.7-4.6 2.7" />
    <rect className="ix-node" x="3" y="12.6" width="3.6" height="6" rx="1.8" />
    <rect className="ix-node" x="17.4" y="12.6" width="3.6" height="6" rx="1.8" />
    <circle className="ix-ink" cx="13.4" cy="21.1" r="1.2" />
  </svg>
);

/** A pencil: its body a stroke, its tip the node. */
export const EditIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M14.6 5.6 18.4 9.4 9.2 18.6 4.8 19.2 5.4 14.8z" />
    <path d="M12.8 7.4 16.6 11.2" />
    <circle className="ix-node" cx="5.6" cy="18.4" r="1.4" />
  </svg>
);

/**
 * ADR 0033 — a meeting of two clients: two arcs, one from each side, closing on the hub between them, the node in the
 * mark's orange where they meet.
 */
export const MeetIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M9.4 5.2A7.2 7.2 0 0 0 9.4 18.8" />
    <path d="M14.6 5.2a7.2 7.2 0 0 1 0 13.6" />
    <path d="M5.6 12h3.2M15.2 12h3.2" />
    <circle className="ix-node" cx="12" cy="12" r="2.2" />
  </svg>
);

/** Another client: a person drawn as the mark draws one — a node over a broken arc. */
export const PeerIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <circle cx="12" cy="8.2" r="3.4" />
    <path d="M5.4 19.6a6.8 6.8 0 0 1 11.4-4.9" />
    <circle className="ix-node" cx="18.4" cy="17.6" r="2.1" />
  </svg>
);

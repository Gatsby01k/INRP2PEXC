/**
 * The workspace's handful of glyphs: 1.5px strokes on a 24px grid, drawn in `currentColor`, never carrying meaning
 * alone — every one sits beside words that say the same thing.
 */
const base = {
  width: 24,
  height: 24,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
};

type IconProps = { className?: string | undefined };

export const BellIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 1.5h-15L6 16.5Z" />
    <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
  </svg>
);

export const InfoIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5" />
    <circle cx="12" cy="7.8" r="0.6" fill="currentColor" />
  </svg>
);

export const ArrowIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M5 12h13" />
    <path d="m13 7 5 5-5 5" />
  </svg>
);

export const BankIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M3.5 9 12 4.5 20.5 9" />
    <path d="M5 9.5v8M9.7 9.5v8M14.3 9.5v8M19 9.5v8" />
    <path d="M3.5 19.5h17" />
  </svg>
);

export const WalletIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <rect x="3.5" y="6" width="17" height="13" rx="2.5" />
    <path d="M3.5 9.5h17" />
    <circle cx="16.5" cy="14.2" r="1" fill="currentColor" stroke="none" />
    <path d="M6.5 6 15 3.8a1.5 1.5 0 0 1 1.8 1.1l.3 1.1" />
  </svg>
);

export const ReceiptIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M6.5 3.5h8l3 3v14h-11Z" />
    <path d="M14.5 3.5v3h3" />
    <path d="M9 11h6M9 14.5h6M9 18h3.5" />
  </svg>
);

export const ChevronIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="m9 6 6 6-6 6" />
  </svg>
);

export const CheckIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="m5.5 12.5 4 4 9-9" />
  </svg>
);

export const ClockIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);

export const PauseIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M10 9v6M14 9v6" />
  </svg>
);

export const ShieldIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M12 3.5 5 6v5.5c0 4.2 3 7.4 7 9 4-1.6 7-4.8 7-9V6l-7-2.5Z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </svg>
);

export const PlusIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M12 5.5v13M5.5 12h13" />
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
    <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
    <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    <circle cx="12" cy="15.5" r="1.2" fill="currentColor" stroke="none" />
  </svg>
);

export const PhoneIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <rect x="7" y="3" width="10" height="18" rx="2.5" />
    <path d="M10.5 18h3" />
  </svg>
);

export const UserIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <circle cx="12" cy="8.5" r="3.5" />
    <path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" />
  </svg>
);

export const UsersIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <circle cx="9" cy="8.5" r="3.2" />
    <path d="M3 19.5c.7-3.2 3-5 6-5s5.3 1.8 6 5" />
    <path d="M15.5 5.6a3.2 3.2 0 0 1 0 5.8M17.5 14.8c1.8.6 3 2.2 3.5 4.7" />
  </svg>
);

export const SignOutIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M14 4.5H7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h7" />
    <path d="M10.5 12H20M16.5 8.5 20 12l-3.5 3.5" />
  </svg>
);

export const DownloadIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5" />
    <path d="M5 19.5h14" />
  </svg>
);

export const CopyIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
    <path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
  </svg>
);

export const PasteIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M9 4.5h6v2.5H9z" />
    <path d="M15 5.5h2a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2h2" />
  </svg>
);

export const ArchiveIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <rect x="3.5" y="4.5" width="17" height="4.5" rx="1.2" />
    <path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9" />
    <path d="M10 13h4" />
  </svg>
);

export const SwapIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M8 4.5v15M4.5 16 8 19.5 11.5 16" />
    <path d="M16 19.5v-15M12.5 8 16 4.5 19.5 8" />
  </svg>
);

export const SparkIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4M6 6l2.6 2.6M15.4 15.4 18 18M6 18l2.6-2.6M15.4 8.6 18 6" />
  </svg>
);

/** A shopfront: the desk, a trader's own exchange (ADR 0020). */
export const StoreIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M4 9.5 5.4 4.8A1 1 0 0 1 6.4 4h11.2a1 1 0 0 1 1 .8L20 9.5" />
    <path d="M4 9.5a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0" />
    <path d="M5.5 12v7a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-7" />
    <path d="M10 20v-4.5h4V20" />
  </svg>
);

export const LinkIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </svg>
);

export const ShareIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M12 15V4" />
    <path d="m8 8 4-4 4 4" />
    <path d="M6 12v6.5A1.5 1.5 0 0 0 7.5 20h9a1.5 1.5 0 0 0 1.5-1.5V12" />
  </svg>
);

export const ChatIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M4.5 19.5 6 15.6A7.5 7.5 0 1 1 9 18.6Z" />
  </svg>
);

export const SendIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M20.5 3.5 10 14" />
    <path d="m20.5 3.5-6.5 17-4-6.5-6.5-4Z" />
  </svg>
);

export const ChartIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M4 20h16" />
    <path d="M7 16v-5" />
    <path d="M12 16V7" />
    <path d="M17 16v-8" />
  </svg>
);

export const TagIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M3.5 12.3V4.5a1 1 0 0 1 1-1h7.8l8.2 8.2a1 1 0 0 1 0 1.4l-7.8 7.8a1 1 0 0 1-1.4 0Z" />
    <circle cx="8" cy="8" r="1.3" />
  </svg>
);

export const PlaneIcon = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M21 4 3 11.2l6.3 2.3L18 7.5l-6.6 7.4.4 5.6 3.2-4.1 4.3 3.1Z" />
  </svg>
);

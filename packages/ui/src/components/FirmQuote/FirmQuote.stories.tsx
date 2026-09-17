import type { Meta, StoryObj } from '@storybook/react-vite';
import { FirmQuote } from './FirmQuote.tsx';
import { CANONICAL_BUY, CANONICAL_SELL, NOW, at, clientRate } from '../../fixtures.ts';

const meta = {
  title: 'Quote/FirmQuote',
  component: FirmQuote,
  tags: ['motion'],
  args: {
    state: 'LOCKED',
    direction: 'SELL_USDT',
    base: CANONICAL_SELL.base,
    inr: CANONICAL_SELL.clientInr,
    rate: clientRate('102.00'),
    network: 'TRC20',
    destinationLabel: 'HDFC •••• 8219',
    expiresAt: at(72),
    validityMs: 180_000,
    now: NOW,
    settlementNote: 'INR in one or more transfers, tracked per UTR',
    onAccept: () => {},
    onDecline: () => {},
    onRequestNew: () => {},
  },
} satisfies Meta<typeof FirmQuote>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Requesting: Story = { args: { state: 'REQUESTING' } };
export const QuoteAvailable: Story = { args: { state: 'QUOTE_AVAILABLE' } };
export const Locked: Story = { tags: ['motion'],};
export const LockedMobile: Story = {};
export const Expiring: Story = { tags: ['motion'], args: { state: 'EXPIRING', expiresAt: at(9) } };
export const Accepted: Story = { args: { state: 'ACCEPTED' } };
export const Expired: Story = { args: { state: 'EXPIRED', expiresAt: at(-1) } };
export const Unavailable: Story = { args: { state: 'UNAVAILABLE' } };
export const BuyUsdt: Story = { args: { direction: 'BUY_USDT', base: CANONICAL_BUY.base, inr: CANONICAL_BUY.clientInr, rate: clientRate('101.10'), destinationLabel: 'TRC20 · TVq…9fA2' } };

import type { Meta, StoryObj } from '@storybook/react-vite';
import { Receipt } from './Receipt.tsx';
import { CANONICAL_SELL, NOW, TRADE_REF, TX_HASH, at, clientRate, inr } from '../../fixtures.ts';

const meta = {
  title: 'Trade/Receipt',
  component: Receipt,
  args: {
    tradeRef: TRADE_REF,
    direction: 'SELL_USDT',
    base: CANONICAL_SELL.base,
    inr: CANONICAL_SELL.clientInr,
    rate: clientRate('102.00'),
    network: 'TRC20',
    txHash: TX_HASH,
    acceptedAt: NOW,
    completedAt: at(3 * 3600 + 12 * 60),
    legs: [
      { amount: inr('2000000'), utr: 'HDFCR52026091617118', confirmedAt: at(1200) },
      { amount: inr('2500000'), utr: 'ICICR52026091614412', confirmedAt: at(1500) },
      { amount: inr('2500000'), utr: 'AXISR52026091609921', confirmedAt: at(4200) },
      { amount: inr('2000000'), utr: 'HDFCR52026091618830', confirmedAt: at(7800) },
      { amount: inr('1200000'), utr: 'ICICR52026091620417', confirmedAt: at(11520) },
    ],
  },
  parameters: { surface: 'surface' },
} satisfies Meta<typeof Receipt>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Settled: Story = {};
export const SettledMobile: Story = {};

import type { Meta, StoryObj } from '@storybook/react-vite';
import { TradeHeader } from './TradeHeader.tsx';
import { TradeProgress } from '../TradeProgress/TradeProgress.tsx';
import { OperationalStatus } from '../OperationalStatus/OperationalStatus.tsx';
import { CANONICAL_BUY, CANONICAL_SELL, NOW, TRADE_REF, at, clientRate } from '../../fixtures.ts';

const meta = { title: 'Trade/TradeHeader', component: TradeHeader, args: { audience: 'client', tradeRef: TRADE_REF, direction: 'SELL_USDT', base: CANONICAL_SELL.base, inr: CANONICAL_SELL.clientInr, rate: clientRate('102.00'), startedAt: NOW } } satisfies Meta<typeof TradeHeader>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ClientSell: Story = {};
export const ClientSellMobile: Story = {};
export const OperatorBuy: Story = { args: { audience: 'operator', clientName: 'Orbit Ltd', direction: 'BUY_USDT', base: CANONICAL_BUY.base, inr: CANONICAL_BUY.clientInr, rate: clientRate('101.10') } as never };

export const ProgressSellPayout: Story = {
  render: () => (
    <div style={{ maxWidth: 480 }}>
      <TradeProgress direction="SELL_USDT" stages={[{ status: 'done', at: NOW }, { status: 'done', at: at(180), detail: '16:14 · confirmed' }, { status: 'current' }, { status: 'pending' }]} />
    </div>
  ),
};
export const ProgressBuyException: Story = {
  render: () => (
    <div style={{ maxWidth: 480 }}>
      <TradeProgress direction="BUY_USDT" stages={[{ status: 'done', at: NOW }, { status: 'exception', detail: 'Short by ₹50,000' }, { status: 'pending' }, { status: 'pending' }]} />
    </div>
  ),
};
export const OperationalStatuses: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
      <OperationalStatus state="AWAITING_FIRST_LEG" />
      <OperationalStatus state="FIRST_LEG_DETECTED" />
      <OperationalStatus state="SETTLING" />
      <OperationalStatus state="PARTIALLY_SETTLED" />
      <OperationalStatus state="PARTIALLY_SETTLED" hold />
      <OperationalStatus state="COMPLETED" />
      <OperationalStatus state="CANCELLED" />
    </div>
  ),
  parameters: { density: 'compact' },
};

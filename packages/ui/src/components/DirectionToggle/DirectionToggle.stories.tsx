import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { Direction } from '@inrp2p/kernel';
import { DirectionToggle } from './DirectionToggle.tsx';
import { CurrencySelector } from '../CurrencySelector/CurrencySelector.tsx';

const meta = { title: 'Exchange/DirectionToggle', component: DirectionToggle, args: { value: 'SELL_USDT', onChange: () => {} } } satisfies Meta<typeof DirectionToggle>;
export default meta;
type Story = StoryObj<typeof meta>;

function Interactive({ initial, size }: { initial: Direction; size?: 'sm' | 'md' }) {
  const [v, setV] = useState<Direction>(initial);
  return <DirectionToggle value={v} onChange={setV} {...(size ? { size } : {})} />;
}

export const SellSelected: Story = { tags: ['motion'], render: () => <Interactive initial="SELL_USDT" /> };
export const BuySelected: Story = { render: () => <Interactive initial="BUY_USDT" /> };
export const OperatorCompact: Story = { render: () => <Interactive initial="SELL_USDT" size="sm" />, parameters: { density: 'compact' } };
export const CurrencyLabels: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 'var(--space-6)' }}>
      <CurrencySelector asset="USDT" network="TRC20" />
      <CurrencySelector asset="INR" />
    </div>
  ),
};

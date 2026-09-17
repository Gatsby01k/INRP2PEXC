import type React from 'react';
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { MoneyInput } from './MoneyInput.tsx';

const meta = { title: 'Exchange/MoneyInput', component: MoneyInput, args: { label: 'Sell', currency: 'USDT', value: '100000', onChange: () => {} } } satisfies Meta<typeof MoneyInput>;
export default meta;
type Story = StoryObj<typeof meta>;

function Controlled(props: Omit<React.ComponentProps<typeof MoneyInput>, 'value' | 'onChange'> & { initial: string }) {
  const { initial, ...rest } = props;
  const [v, setV] = useState(initial);
  return <div style={{ maxWidth: 'var(--client-exchange-max)' }}><MoneyInput {...rest} value={v} onChange={setV} /></div>;
}

export const DisplayUsdt: Story = { render: () => <Controlled label="Sell" currency="USDT" size="display" suffix="USDT · TRC20" initial="100000" /> };
export const DisplayUsdtMobile: Story = { render: () => <Controlled label="Sell" currency="USDT" size="display" suffix="USDT · TRC20" initial="100000" /> };
export const FieldInr: Story = { render: () => <Controlled label="Payout amount" currency="INR" initial="2000000" hint="Max ₹3,200,000 unallocated" /> };
export const Empty: Story = { render: () => <Controlled label="Sell" currency="USDT" size="display" initial="" /> };
export const OverAllocationError: Story = { render: () => <Controlled label="Payout amount" currency="INR" initial="3500000" error="Exceeds unallocated obligation of ₹3,200,000" /> };

import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { PayerSelector, type Payer } from './PayerSelector.tsx';
import { RoutePositionRow } from '../RoutePositionRow/RoutePositionRow.tsx';
import { inr, usdt } from '../../fixtures.ts';

const meta = { title: 'Settlement/RouteSettlement', component: PayerSelector, args: { value: 'EXCHANGE_ACCOUNT', onChange: () => {}, executionMode: 'DIRECT_TO_CLIENT' }, parameters: { density: 'compact' } } satisfies Meta<typeof PayerSelector>;
export default meta;
type Story = StoryObj<typeof meta>;

function Controlled({ mode, initial }: { mode: 'DIRECT_TO_CLIENT' | 'TO_EXCHANGE'; initial: Payer }) {
  const [v, setV] = useState<Payer>(initial);
  return <div style={{ maxWidth: 380 }}><PayerSelector value={v} onChange={setV} executionMode={mode} /></div>;
}

export const DirectToClientRouteSelected: Story = { render: () => <Controlled mode="DIRECT_TO_CLIENT" initial="ROUTE" /> };
export const ToExchangeRouteDisabled: Story = { render: () => <Controlled mode="TO_EXCHANGE" initial="EXCHANGE_ACCOUNT" /> };
export const RoutePositionResidual: Story = {
  render: () => (
    <div style={{ maxWidth: 820 }}>
      <RoutePositionRow
        audience="operator"
        tradeRef="IX-260916-1842"
        routeName="Route A"
        executionMode="DIRECT_TO_CLIENT"
        status="PARTIALLY_SETTLED"
        routeDelivers={{ total: inr('10420000'), allocated: inr('10200000'), note: '₹10,200,000 direct to client · UTR ••••0091' }}
        exchangeDelivers={{ total: usdt('100000'), allocated: usdt('0') }}
      />
    </div>
  ),
};
export const RoutePositionSettled: Story = {
  render: () => (
    <div style={{ maxWidth: 820 }}>
      <RoutePositionRow audience="operator" tradeRef="IX-260915-0931" routeName="Route B" executionMode="TO_EXCHANGE" status="SETTLED" routeDelivers={{ total: inr('4689000'), allocated: inr('4689000') }} exchangeDelivers={{ total: usdt('45000'), allocated: usdt('45000') }} />
    </div>
  ),
};

import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TradeTable, type TradeTableColumn } from './TradeTable.tsx';
import { OperationalStatus, type TradeLifecycleState } from '../OperationalStatus/OperationalStatus.tsx';

interface Row { ref: string; client: string; direction: string; usdt: string; rate: string; inr: string; margin: string; state: TradeLifecycleState; hold?: boolean }
const rows: Row[] = [
  { ref: 'IX-260916-1842', client: 'Acme Pay', direction: 'SELL', usdt: '100,000', rate: '₹102.00', inr: '₹10,200,000', margin: '+₹220,000', state: 'PARTIALLY_SETTLED' },
  { ref: 'IX-260916-1837', client: 'Kite FX', direction: 'SELL', usdt: '250,000', rate: '₹102.10', inr: '₹25,525,000', margin: '+₹550,000', state: 'SETTLING' },
  { ref: 'IX-260916-1829', client: 'Orbit Ltd', direction: 'BUY', usdt: '20,000', rate: '₹101.10', inr: '₹2,022,000', margin: '+₹22,000', state: 'FIRST_LEG_DETECTED' },
  { ref: 'IX-260916-1811', client: 'Zen Pay', direction: 'SELL', usdt: '100,000', rate: '₹102.00', inr: '₹10,200,000', margin: '+₹220,000', state: 'AWAITING_FIRST_LEG', hold: true },
  { ref: 'IX-260915-0931', client: 'Nova OTC', direction: 'SELL', usdt: '45,000', rate: '₹102.20', inr: '₹4,599,000', margin: '+₹90,000', state: 'COMPLETED' },
];
const columns: TradeTableColumn<Row>[] = [
  { key: 'ref', header: 'Trade', render: (r) => r.ref, sortable: true },
  { key: 'client', header: 'Client', render: (r) => r.client, sortable: true },
  { key: 'direction', header: 'Direction', render: (r) => r.direction },
  { key: 'usdt', header: 'USDT', numeric: true, render: (r) => r.usdt, sortable: true },
  { key: 'rate', header: 'Client rate', numeric: true, render: (r) => r.rate },
  { key: 'inr', header: 'INR', numeric: true, render: (r) => r.inr },
  { key: 'margin', header: 'Gross margin', numeric: true, render: (r) => r.margin },
  { key: 'state', header: 'Status', render: (r) => <OperationalStatus state={r.state} hold={Boolean(r.hold)} /> },
];

const meta = { title: 'Operator/TradeTable', component: TradeTable, parameters: { density: 'compact' } } satisfies Meta<typeof TradeTable>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Orders: Story = {
  args: { caption: 'Orders', columns: columns as never, rows: rows as never, rowKey: ((r: Row) => r.ref) as never },
  render: () => {
    const [sort, setSort] = useState<{ key: string; direction: 'ascending' | 'descending' }>({ key: 'ref', direction: 'descending' });
    return <TradeTable caption="Orders · today" columns={columns} rows={rows} rowKey={(r) => r.ref} sort={sort} onSort={(key) => setSort((s) => ({ key, direction: s.key === key && s.direction === 'descending' ? 'ascending' : 'descending' }))} onRowOpen={() => {}} />;
  },
};
export const OrdersComfortableDensity: Story = { ...Orders, parameters: { density: 'comfortable' } };

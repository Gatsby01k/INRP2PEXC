import type { Meta, StoryObj } from '@storybook/react-vite';
import { ActionQueue, type QueueGroup } from './ActionQueue.tsx';
import { EmptyState } from '../EmptyState/EmptyState.tsx';

const noop = () => {};
const groups: QueueGroup[] = [
  {
    key: 'needs_action',
    items: [
      { id: '1', client: 'Acme Pay', amount: 'SELL 100,000 USDT', asks: '102.00', route: '104.20', margin: '+₹220,000', status: 'New request', action: { label: 'Quote', shortcut: 'Q', onAction: noop } },
      { id: '2', client: 'Nova OTC', amount: 'SELL 45,000 USDT', route: '104.20', status: 'USDT confirmed', action: { label: 'Create INR payout', shortcut: 'P', onAction: noop } },
      { id: '3', client: 'Orbit Ltd', amount: 'BUY 20,000 USDT', asks: '101.10', route: '100.00', margin: '+₹22,000', status: 'INR claimed', action: { label: 'Confirm INR', onAction: noop } },
    ],
  },
  { key: 'settlement', items: [{ id: '4', client: 'Kite FX', amount: 'SELL 250,000 USDT', asks: '102.10', route: '104.30', margin: '+₹550,000', status: '₹14.5M / ₹25.5M', action: { label: 'Add UTR', shortcut: 'U', onAction: noop } }] },
  { key: 'waiting_client', items: [{ id: '5', client: 'Delta Pay', amount: 'SELL 60,000 USDT', asks: '102.05', status: 'Quote sent · expires 00:48', action: { label: 'Copy link', onAction: noop } }] },
  { key: 'processing', items: [{ id: '6', client: 'Sigma', amount: 'SELL 100,000 USDT', status: 'USDT detected · awaiting solidification' }] },
  { key: 'exception', items: [{ id: '7', client: 'Zen Pay', amount: 'SELL 100,000 USDT', status: 'Short by 50 USDT', action: { label: 'Resolve', shortcut: 'E', onAction: noop } }] },
];

const meta = { title: 'Operator/DeskQueue', component: ActionQueue, args: { groups }, parameters: { density: 'compact' } } satisfies Meta<typeof ActionQueue>;
export default meta;
type Story = StoryObj<typeof meta>;

export const LiveQueue: Story = {};
export const EmptyQueue: Story = { args: { groups: [], emptyState: <EmptyState title="Nothing needs action" body="New requests, confirmations and exceptions appear here as they happen." /> } };

import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { UTRField } from './UTRField.tsx';
import { TransactionHash } from '../TransactionHash/TransactionHash.tsx';
import { TX_HASH } from '../../fixtures.ts';

const meta = { title: 'Settlement/Evidence', component: UTRField, args: { value: '', onChange: () => {} }, parameters: { density: 'compact' } } satisfies Meta<typeof UTRField>;
export default meta;
type Story = StoryObj<typeof meta>;

function Controlled(props: { initial: string; check?: 'idle' | 'checking' | 'available' | 'duplicate'; duplicateOf?: string }) {
  const [v, setV] = useState(props.initial);
  return <div style={{ maxWidth: 360 }}><UTRField value={v} onChange={setV} {...(props.check ? { check: props.check } : {})} {...(props.duplicateOf ? { duplicateOf: props.duplicateOf } : {})} /></div>;
}

export const UtrEmpty: Story = { render: () => <Controlled initial="" /> };
export const UtrAvailable: Story = { render: () => <Controlled initial="HDFCR52026091617118" check="available" /> };
export const UtrDuplicate: Story = { render: () => <Controlled initial="HDFCR52026091617118" check="duplicate" duplicateOf="IX-260915-0931-L2" /> };
export const TxHashWithFinality: Story = { render: () => <TransactionHash hash={TX_HASH} finality="Solidified · confirmed" explorerUrl="https://tronscan.org/#/transaction/7c1e" /> };
export const TxHashDetected: Story = { render: () => <TransactionHash hash={TX_HASH} finality="Detected · awaiting solidification" copy={false} /> };

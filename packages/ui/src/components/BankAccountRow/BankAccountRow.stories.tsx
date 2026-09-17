import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { BankAccountRow } from './BankAccountRow.tsx';
import { WalletRow } from '../WalletRow/WalletRow.tsx';
import { CLIENT_WALLET, DEPOSIT_ADDRESS } from '../../fixtures.ts';

const meta = { title: 'Accounts/BankAndWallets', component: BankAccountRow, args: { bankName: 'HDFC Bank', holderName: 'Acme Pay Pvt Ltd', last4: '8219', rail: 'IMPS · RTGS', status: 'ACTIVE', isDefault: true } } satisfies Meta<typeof BankAccountRow>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Archived: Story = { args: { status: 'ARCHIVED', isDefault: false } };
export const PickerMobile: Story = {
  render: () => {
    const [sel, setSel] = useState('a');
    return (
      <div role="radiogroup" aria-label="Receive to" style={{ display: 'grid', gap: 'var(--space-2)', maxWidth: 480 }}>
        <BankAccountRow bankName="HDFC Bank" holderName="Acme Pay Pvt Ltd" last4="8219" status="ACTIVE" isDefault selected={sel === 'a'} onSelect={() => setSel('a')} />
        <BankAccountRow bankName="ICICI Bank" holderName="Acme Pay Pvt Ltd" last4="4410" status="ACTIVE" selected={sel === 'b'} onSelect={() => setSel('b')} />
      </div>
    );
  },
};
export const Wallets: Story = {
  render: () => (
    <div role="radiogroup" aria-label="Deliver to" style={{ display: 'grid', gap: 'var(--space-2)', maxWidth: 480 }}>
      <WalletRow address={CLIENT_WALLET} network="TRC20" label="Treasury wallet" status="ACTIVE" selected onSelect={() => {}} />
      <WalletRow address={DEPOSIT_ADDRESS} network="TRC20" label="Old hot wallet" status="ARCHIVED" onSelect={() => {}} />
    </div>
  ),
};

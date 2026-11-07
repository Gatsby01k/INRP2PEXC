import type { Meta, StoryObj } from '@storybook/react-vite';
import { WalletRow } from './WalletRow.tsx';
import { DEPOSIT_ADDRESS } from '../../fixtures.ts';

const meta = { title: 'Treasury/WalletRow', component: WalletRow, args: { address: DEPOSIT_ADDRESS, network: 'TRC20', label: 'Acme wallet', status: 'ACTIVE' } } satisfies Meta<typeof WalletRow>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Active: Story = {};
export const Selected: Story = { args: { selected: true } };
export const Paused: Story = { args: { status: 'PAUSED' } };

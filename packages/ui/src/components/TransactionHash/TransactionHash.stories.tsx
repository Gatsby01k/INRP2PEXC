import type { Meta, StoryObj } from '@storybook/react-vite';
import { TransactionHash } from './TransactionHash.tsx';
import { TX_HASH } from '../../fixtures.ts';

const meta = { title: 'Treasury/TransactionHash', component: TransactionHash, args: { hash: TX_HASH } } satisfies Meta<typeof TransactionHash>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Confirmed: Story = { args: { finality: 'Solidified · 100,000.000000 USDT confirmed' } };
export const WithoutCopy: Story = { args: { finality: 'Confirmed', copy: false } };

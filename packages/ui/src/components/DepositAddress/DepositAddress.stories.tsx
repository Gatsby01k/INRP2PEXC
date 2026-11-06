import type { Meta, StoryObj } from '@storybook/react-vite';
import { DepositAddress } from './DepositAddress.tsx';
import { DEPOSIT_ADDRESS, TRADE_REF, usdt } from '../../fixtures.ts';

const meta = { title: 'Treasury/DepositAddress', component: DepositAddress, args: { address: DEPOSIT_ADDRESS, amount: usdt('100000'), network: 'TRC20', tradeRef: TRADE_REF } } satisfies Meta<typeof DepositAddress>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ClientInstructions: Story = {};
export const ClientInstructionsMobile: Story = {};
import type { Meta, StoryObj } from '@storybook/react-vite';
import { DepositAddress } from './DepositAddress.tsx';
import { DepositPoolStatus } from '../DepositPoolStatus/DepositPoolStatus.tsx';
import { DEPOSIT_ADDRESS, TRADE_REF, usdt } from '../../fixtures.ts';

const meta = { title: 'Treasury/DepositAddress', component: DepositAddress, args: { address: DEPOSIT_ADDRESS, amount: usdt('100000'), network: 'TRC20', tradeRef: TRADE_REF } } satisfies Meta<typeof DepositAddress>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ClientInstructions: Story = {};
export const ClientInstructionsMobile: Story = {};
export const PoolDerived: Story = { render: () => <DepositPoolStatus capability="DERIVED" provider="Custody provider" available={0} assigned={7} cooldown={31} lowThreshold={20} />, parameters: { density: 'compact' } };
export const PoolLow: Story = { render: () => <DepositPoolStatus capability="POOL" provider="Custody provider" available={12} assigned={7} cooldown={31} lowThreshold={20} />, parameters: { density: 'compact' } };
export const CustodyUnsupported: Story = { render: () => <DepositPoolStatus capability="UNSUPPORTED" provider="Custody provider" available={0} assigned={0} cooldown={0} lowThreshold={20} />, parameters: { density: 'compact' } };

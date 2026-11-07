import type { Meta, StoryObj } from '@storybook/react-vite';
import { SettlementProgress } from './SettlementProgress.tsx';
import { CANONICAL_SELL, inr } from '../../fixtures.ts';

const meta = { title: 'Trade/SettlementProgress', component: SettlementProgress, args: { received: inr('4500000'), total: CANONICAL_SELL.clientInr } } satisfies Meta<typeof SettlementProgress>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Partial: Story = {};
export const InFlight: Story = { args: { inFlight: inr('2500000') } };
export const Compact: Story = { args: { compact: true } };

import type { Meta, StoryObj } from '@storybook/react-vite';
import { PnlSummary } from './PnlSummary.tsx';
import { inr, usdt } from '../../fixtures.ts';

const meta = { title: 'Operator/PnlSummary', component: PnlSummary, args: { periodLabel: 'Today · 16 Sep 2026', realizedMargin: inr('612400'), completedVolume: usdt('290000'), completedTrades: 4, openExpectedMargin: inr('1012000'), openTrades: 7 } } satisfies Meta<typeof PnlSummary>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Today: Story = {};
export const Canonical: Story = { args: { realizedMargin: inr('220000'), completedVolume: usdt('100000'), completedTrades: 1, openExpectedMargin: inr('0'), openTrades: 0 } };
export const NoCompletedTrades: Story = { args: { realizedMargin: inr('0'), completedVolume: usdt('0'), completedTrades: 0 } };

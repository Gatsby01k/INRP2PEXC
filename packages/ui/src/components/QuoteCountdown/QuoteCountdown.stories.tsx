import type { Meta, StoryObj } from '@storybook/react-vite';
import { QuoteCountdown } from './QuoteCountdown.tsx';
import { NOW, at } from '../../fixtures.ts';

const meta = { title: 'Quote/QuoteCountdown', component: QuoteCountdown, args: { expiresAt: at(72), validityMs: 180_000, now: NOW } } satisfies Meta<typeof QuoteCountdown>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Locked: Story = { tags: ['motion'],};
export const Expiring: Story = { tags: ['motion'], args: { expiresAt: at(9) } };
export const Expired: Story = { args: { expiresAt: at(-1) } };
export const Small: Story = { args: { size: 'sm', expiresAt: at(48), validityMs: 90_000 } };
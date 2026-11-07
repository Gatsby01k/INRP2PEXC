import type { Meta, StoryObj } from '@storybook/react-vite';
import { EmptyState } from './EmptyState.tsx';

const meta = { title: 'Feedback/EmptyState', component: EmptyState, args: { title: 'No completed trades yet', body: 'Completed trades and their receipts appear here.' } } satisfies Meta<typeof EmptyState>;
export default meta;
type Story = StoryObj<typeof meta>;

export const History: Story = {};

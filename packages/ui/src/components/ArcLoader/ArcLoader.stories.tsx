import type { Meta, StoryObj } from '@storybook/react-vite';
import { ArcLoader } from './ArcLoader.tsx';
import { ArcMotif } from '../ArcMotif/ArcMotif.tsx';

const meta = { title: 'Core/ArcLoader', component: ArcLoader } satisfies Meta<typeof ArcLoader>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Medium: Story = { tags: ['motion'], args: { size: 'md', label: 'Desk is pricing your request' } };
export const Large: Story = { tags: ['motion'], args: { size: 'lg' } };
export const ThreeArcMotif: Story = {
  args: {},
  render: () => (
    <div style={{ display: 'flex', gap: 'var(--space-6)', alignItems: 'center' }}>
      <span><ArcMotif completed={0} size={32} /> requested</span>
      <span><ArcMotif completed={1} size={32} /> quoted</span>
      <span><ArcMotif completed={2} size={32} /> funded</span>
      <span><ArcMotif completed={3} size={32} /> settled</span>
    </div>
  ),
};

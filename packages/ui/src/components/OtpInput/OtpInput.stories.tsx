import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { OtpInput } from './OtpInput.tsx';

const meta = { title: 'Core/Inputs', component: OtpInput, args: { value: '', onChange: () => {} } } satisfies Meta<typeof OtpInput>;
export default meta;
type Story = StoryObj<typeof meta>;

function Controlled({ initial, invalid }: { initial: string; invalid?: boolean }) {
  const [v, setV] = useState(initial);
  return <OtpInput value={v} onChange={setV} {...(invalid ? { invalid } : {})} />;
}

export const OtpPartial: Story = { render: () => <Controlled initial="482" /> };
export const OtpInvalid: Story = { render: () => <Controlled initial="482199" invalid /> };
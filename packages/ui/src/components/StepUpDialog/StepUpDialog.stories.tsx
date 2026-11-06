import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { StepUpDialog } from './StepUpDialog.tsx';

const meta = { title: 'Operator/Security', component: StepUpDialog, args: { open: true, actionSummary: 'Confirm payout ₹2,500,000 · IX-260916-1842-L3', code: '', onCodeChange: () => {}, onConfirm: () => {}, onCancel: () => {} }, parameters: { layout: 'fullscreen' } } satisfies Meta<typeof StepUpDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

function Controlled({ initial, error }: { initial: string; error?: string }) {
  const [c, setC] = useState(initial);
  return <StepUpDialog open actionSummary="Confirm payout ₹2,500,000 · IX-260916-1842-L3" code={c} onCodeChange={setC} onConfirm={() => {}} onCancel={() => {}} {...(error ? { error } : {})} />;
}

export const StepUp: Story = { render: () => <Controlled initial="" /> };
export const StepUpInvalid: Story = { render: () => <Controlled initial="112233" error="Code not accepted. Check your authenticator and try again." /> };
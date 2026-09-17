import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { AcceptanceVerification, type VerificationState } from './AcceptanceVerification.tsx';

const recipients = [
  { id: 'u1', masked: 'a•••@acmepay.in' },
  { id: 'u2', masked: 'r•••@acmepay.in' },
];

function Flow({ state, intent = 'accept', code = '', attempts, resend }: { state: VerificationState; intent?: 'accept' | 'reject'; code?: string; attempts?: number; resend?: number }) {
  const [c, setC] = useState(code);
  const [sel, setSel] = useState('u1');
  return (
    <AcceptanceVerification
      state={state}
      intent={intent}
      recipients={recipients}
      selectedRecipientId={sel}
      onSelectRecipient={setSel}
      code={c}
      onCodeChange={setC}
      {...(attempts !== undefined ? { attemptsRemaining: attempts } : {})}
      {...(resend !== undefined ? { resendInSeconds: resend } : {})}
      onSend={() => {}}
      onConfirm={() => {}}
      onCancel={() => {}}
    />
  );
}

const meta = { title: 'QuoteLink/AcceptanceVerification', component: AcceptanceVerification } satisfies Meta<typeof AcceptanceVerification>;
export default meta;
type Story = StoryObj<typeof meta>;
const base = { args: {} as never };

export const ChooseRecipientMobile: Story = { ...base, render: () => <Flow state="choose" /> };
export const CodeSentMobile: Story = { ...base, render: () => <Flow state="sent" code="4821" resend={24} /> };
export const WrongCodeMobile: Story = { ...base, render: () => <Flow state="invalid" code="482199" attempts={3} /> };
export const LockedMobile: Story = { ...base, render: () => <Flow state="locked" code="000000" attempts={0} /> };
export const RejectWithCode: Story = { ...base, render: () => <Flow state="sent" intent="reject" code="" resend={0} /> };
export const QuoteExpiredDuringVerification: Story = { ...base, render: () => <Flow state="expired" /> };

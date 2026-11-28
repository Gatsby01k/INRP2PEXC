import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DEMAND_MATCH, PLAYBOOKS, robotIntel } from '@inrp2p/robot';
import { can, operatorPage } from '../../../server/operator.ts';
import { robotMind } from '../../../server/robot.ts';
import { Empty, KpiBand, Notice, Page, PageBody, PageHeader, Section } from '../_desk/ui.tsx';
import { RobotActivity, RobotCases, RobotControls, RobotFunnel, RobotPlaybooks } from './RobotDesk.tsx';

export const dynamic = 'force-dynamic';

/**
 * The robot (ADR 0034) as INRP2P's desk sees it: what to do now, the questions it passed to a person, who is stuck
 * where and for how long, demand nobody served and the liquidity online, what it sent and what came of it — and what
 * it may do on its own. Everything here is read from the rows; nothing on this page acts by itself.
 */
export default async function RobotDeskPage() {
  const ctx = await operatorPage();
  if (!can(ctx, 'robot:view')) notFound();
  const intel = await robotIntel(ctx.db, { aiConfigured: robotMind() !== null, canSeeTraders: can(ctx, 'traders:view') });
  const { demand, liquidity } = intel;
  const playbooks = [...PLAYBOOKS.map((p) => ({ key: p.key, label: p.label })), { key: DEMAND_MATCH.key, label: DEMAND_MATCH.label }];
  const reasons = Object.entries(demand.unpriced7d.byReason).map(([k, n]) => `${n} ${k.toLowerCase().replace(/_/g, ' ')}`).join(' · ');

  return (
    <Page>
      <PageHeader title="Robot" meta="INRP2P’s front line: who is stuck, what nobody served, what it said and what came of it" />
      <PageBody>
        {intel.recommendations.length > 0 ? (
          <Section title="What to do" count={intel.recommendations.length} hint="From the facts below — each says where it is done.">
            <div style={{ display: 'grid', gap: 8 }}>
              {intel.recommendations.map((r) => (
                <Notice key={r.key} tone={r.severity === 'ACT' ? 'warning' : 'brand'} icon={r.severity === 'ACT' ? 'flag' : 'dot'}>
                  <strong>{r.title}.</strong> {r.detail} {r.href ? <Link href={r.href}>Open →</Link> : null}
                </Notice>
              ))}
            </div>
          </Section>
        ) : null}

        <KpiBand
          label="Demand and liquidity"
          items={[
            { key: 'ws', label: 'Waiting to sell', value: String(demand.waiting.SELL_USDT.requests), sub: `≈ ${demand.waiting.SELL_USDT.usdt} USDT · ${liquidity.SELL_USDT.sidesOnline} buying side${liquidity.SELL_USDT.sidesOnline === 1 ? '' : 's'} online`, ...(demand.waiting.SELL_USDT.requests > 0 && liquidity.SELL_USDT.sidesOnline === 0 ? { tone: 'warning' as const } : {}) },
            { key: 'wb', label: 'Waiting to buy', value: String(demand.waiting.BUY_USDT.requests), sub: `≈ ${demand.waiting.BUY_USDT.usdt} USDT · ${liquidity.BUY_USDT.sidesOnline} selling side${liquidity.BUY_USDT.sidesOnline === 1 ? '' : 's'} online`, ...(demand.waiting.BUY_USDT.requests > 0 && liquidity.BUY_USDT.sidesOnline === 0 ? { tone: 'warning' as const } : {}) },
            { key: 'un', label: 'Unpriced, 7 days', value: String(demand.unpriced7d.requests), sub: reasons || 'none', ...(demand.unpriced7d.requests > 0 ? { tone: 'warning' as const } : {}) },
            { key: 'ask', label: 'Asked, 7 days', value: String(demand.asked7d.SELL_USDT.requests + demand.asked7d.BUY_USDT.requests), sub: `sell ≈ ${demand.asked7d.SELL_USDT.usdt} · buy ≈ ${demand.asked7d.BUY_USDT.usdt} USDT` },
            { key: 'q', label: 'Questions, 7 days', value: String(intel.answers7d.rule + intel.answers7d.ai + intel.answers7d.toPerson), sub: `${intel.answers7d.rule} by rule · ${intel.answers7d.ai} by model · ${intel.answers7d.toPerson} to a person` },
          ]}
        />

        <Section title="Questions for a person" count={intel.openCases.length} hint="People asked the robot something it could not answer, or asked for a person.">
          {intel.openCases.length === 0 ? <Empty title="No open questions" body="Answered questions reach the person where they asked." /> : <RobotCases cases={intel.openCases} canAnswer={can(ctx, 'robot:answer')} />}
        </Section>

        <Section title="Who is stuck where" hint="People on their way in, now — a row in orange has waited a day or more." flush>
          <RobotFunnel steps={intel.funnel} />
        </Section>
        <Section title="What it sent" hint="Thirty days: each playbook's messages, and how many people then did the thing." flush>
          <RobotPlaybooks rows={intel.playbooks} />
        </Section>

        <Section title="On its own" hint="What the robot may do without a person: reach people outside the app, and how it answers.">
          {intel.policy.outreach === 'DRY_RUN' ? <Notice tone="brand" icon="clock">Dry run: every message below is what it would have sent. Nothing left the app.</Notice> : null}
          <RobotControls policy={intel.policy} canSet={can(ctx, 'robot:configure')} aiConfigured={intel.aiConfigured} playbooks={playbooks} />
        </Section>

        <Section title="Activity" hint="The latest of what it decided — sent, or in a dry run, would have." flush>
          <RobotActivity rows={intel.recent} />
        </Section>
      </PageBody>
    </Page>
  );
}

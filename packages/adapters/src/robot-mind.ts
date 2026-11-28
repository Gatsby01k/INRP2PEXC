import Anthropic from '@anthropic-ai/sdk';

/**
 * The robot's model (ADR 0034 §2.8): asked only when no rule answers a person's question, and only with what the robot
 * already knows about that person in words — never an account number, an address, a key or another person. It returns
 * an answer and whether a person at INRP2P should take the question; the robot checks the answer again before anyone
 * reads it (every figure must be one it gave the model), so a model that invents a rate is simply not heard.
 *
 * Off unless configured: `ANTHROPIC_API_KEY` (the SDK's own variable) and the owner switching answers to `AI`. The model
 * is `ROBOT_AI_MODEL` (default `claude-opus-5-5`, at low effort; `claude-haiku-5-5` costs about a fortieth as much).
 */
export interface MindQuestion {
  /** The product's facts the model may use: what INRP2P is and how it works, in plain words. */
  readonly handbook: string;
  /** What the robot knows about the person asking, in words. */
  readonly facts: string;
  readonly question: string;
}

export interface MindAnswer {
  readonly answer: string;
  /** The model judged that a person should answer this (a decision, an exception, something it does not know). */
  readonly handoff: boolean;
  /** A short label of what was asked, in capitals: `FEES`, `KYC`, `LIMITS`. */
  readonly intent: string;
}

export interface RobotMind {
  readonly model: string;
  answer(q: MindQuestion): Promise<MindAnswer>;
}

export class RobotMindError extends Error {
  readonly code: 'REFUSED' | 'TRUNCATED' | 'BAD_OUTPUT' | 'UNAVAILABLE';
  constructor(code: RobotMindError['code'], message?: string) {
    super(message ?? code);
    this.name = 'RobotMindError';
    this.code = code;
  }
}

const SYSTEM = `You are the robot of INRP2P, a USDT ↔ INR P2P exchange in India: escrow with a face. You answer one person's question in the app or on Telegram.

Rules — they are not negotiable:
- Use only the HANDBOOK and the PERSON facts you are given. If they do not contain the answer, say you do not know and set handoff to true.
- Never state a rate, an amount, a time, a fee or a status that is not written in those facts. Never estimate or promise one.
- Never decide or predict a dispute, a payment, a refund, an approval or a review: say who decides and set handoff to true if the person needs that decision.
- Never ask for or accept a password, a sign-in code, a private key, a seed phrase, card or bank numbers.
- Never name another client or a trader. Never give legal, tax or investment advice.
- Answer in the language the person wrote in (English, Hindi or Hinglish are common). Plain words, at most four short sentences, no markdown.
- Set handoff to true when the person asks for a human, is upset about money, or the question needs a decision by INRP2P.
- intent: one or two words in capitals with underscores naming the topic, such as FEES, LIMITS, HOW_TO_SELL, ACCOUNT, OTHER.`;

const SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    handoff: { type: 'boolean' },
    intent: { type: 'string' },
  },
  required: ['answer', 'handoff', 'intent'],
  additionalProperties: false,
} as const;

export class AnthropicRobotMind implements RobotMind {
  readonly model: string;
  private readonly client: Anthropic;

  constructor(opts: { model?: string; apiKey?: string; timeoutMs?: number } = {}) {
    this.model = opts.model ?? 'claude-opus-5-5';
    // A person is waiting on the other side: a slow answer is worse than a hand-off, so the wait is short.
    this.client = new Anthropic({ ...(opts.apiKey ? { apiKey: opts.apiKey } : {}), timeout: opts.timeoutMs ?? 20_000, maxRetries: 1 });
  }

  async answer(q: MindQuestion): Promise<MindAnswer> {
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 2000,
        // A model that declines is replaced by one the API chooses for that kind of refusal, in the same call.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        system: [{ type: 'text', text: SYSTEM }, { type: 'text', text: `HANDBOOK\n${q.handbook}`, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: `PERSON\n${q.facts}\n\nQUESTION\n${q.question}` }],
      });
    } catch (e) {
      if (e instanceof Anthropic.APIError) throw new RobotMindError('UNAVAILABLE', `${e.status ?? 'network'}: ${e.message.slice(0, 120)}`);
      throw new RobotMindError('UNAVAILABLE', e instanceof Error ? e.message.slice(0, 120) : 'unknown');
    }
    if (response.stop_reason === 'refusal') throw new RobotMindError('REFUSED', response.stop_details?.category ?? undefined);
    if (response.stop_reason === 'max_tokens') throw new RobotMindError('TRUNCATED');
    const text = response.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new RobotMindError('BAD_OUTPUT', 'not JSON');
    }
    const o = parsed as Record<string, unknown>;
    if (typeof o.answer !== 'string' || typeof o.handoff !== 'boolean' || typeof o.intent !== 'string') throw new RobotMindError('BAD_OUTPUT', 'wrong shape');
    return { answer: o.answer, handoff: o.handoff, intent: o.intent };
  }
}

/** A mind for tests: answers from a function, records what it was asked. */
export class FakeRobotMind implements RobotMind {
  readonly model = 'fake';
  readonly asked: MindQuestion[] = [];
  private readonly reply: (q: MindQuestion) => MindAnswer | Error;
  constructor(reply: (q: MindQuestion) => MindAnswer | Error) {
    this.reply = reply;
  }
  async answer(q: MindQuestion): Promise<MindAnswer> {
    this.asked.push(q);
    const r = this.reply(q);
    if (r instanceof Error) throw r;
    return r;
  }
}

/** The model, when the environment configures one; null otherwise — the robot then answers by its rules alone. */
export function robotMindFromEnv(env: Record<string, string | undefined> = process.env): RobotMind | null {
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  const model = env.ROBOT_AI_MODEL?.trim();
  return new AnthropicRobotMind({ apiKey: key, ...(model ? { model } : {}) });
}

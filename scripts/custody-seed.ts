import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { randomInt } from 'node:crypto';
import { HdDepositAccount, type KeyEncryptionKey } from '@inrp2p/adapters';
import { HdSigner, POOL_RECORD_PATH, custodyKekFromEnv, isCustodyMnemonic, newCustodyMnemonic, openCustodySeed, sealCustodySeed } from '@inrp2p/adapters/signer';
import { DomainError } from '@inrp2p/kernel';

/**
 * The custody seed of the exchange's own HD wallet (ADR 0017 §3, RUNBOOKS `custody-seed`).
 *
 *   INRP2P_ENV=production INRP2P_CUSTODY_KEK_PROVIDER=aws-kms INRP2P_CUSTODY_KMS_KEY_ARN=… INRP2P_CUSTODY_KEK_ID=custody-v1
 *   node scripts/custody-seed.ts new | verify | recover [--seal] | address <index>
 *
 * - `new` makes a 24-word seed from the machine's CSPRNG and shows it once, on a terminal only, to be written on paper
 *   twice; it asks for three of the words back before it goes on. It then seals the seed under the custody key (the
 *   value the worker's `INRP2P_CUSTODY_SEED_SEALED` holds) and prints what is public: the account's extended public
 *   key (the web app's `INRP2P_CUSTODY_XPUB`), the network budget wallet, the record address of the deal-address
 *   pool, and deal address #0 for checking in any TRON wallet.
 * - `verify` opens `INRP2P_CUSTODY_SEED_SEALED` with the custody key, as the worker will, and prints the same public
 *   facts; with `INRP2P_CUSTODY_XPUB` set it says whether the web app's key matches.
 * - `recover` takes the 24 words typed back (never echoed) and prints the public facts — the same seed opens the same
 *   addresses in any BIP-44 TRON wallet (m/44'/195'/0'/0/i deal addresses, m/44'/195'/1'/0/0 the budget wallet).
 *   With `--seal` it seals them again under the custody key: a new environment, or a new key.
 * - `address <index>` derives deal address #index from `INRP2P_CUSTODY_XPUB` alone (nothing secret).
 *
 * The words are never written to a file, an argument, the environment or a log; the sealed value is printed because it
 * is useless without the KMS key, which only the worker's role may use to decrypt.
 */

export { POOL_RECORD_PATH };

export interface CustodyFacts {
  readonly accountXpub: string;
  readonly budgetWallet: string;
  readonly poolRecordAddress: string;
  readonly firstDealAddress: string;
}

export function custodyFacts(mnemonic: string): CustodyFacts {
  const signer = HdSigner.fromMnemonic(mnemonic);
  try {
    return factsOf(signer);
  } finally {
    signer.close();
  }
}

const factsOf = (signer: HdSigner): CustodyFacts => ({
  accountXpub: signer.accountXpub,
  budgetWallet: signer.feeWalletAddress,
  poolRecordAddress: signer.poolRecordAddress,
  firstDealAddress: new HdDepositAccount(signer.accountXpub).addressAt(0n).address,
});

/** Three distinct positions (1-based) to ask back, so a seed is never sealed before it was written down. */
export function confirmationPositions(): number[] {
  const picked = new Set<number>();
  while (picked.size < 3) picked.add(randomInt(1, 25));
  return [...picked].sort((a, b) => a - b);
}

export async function sealNew(mnemonic: string, kek: KeyEncryptionKey): Promise<{ sealed: string; facts: CustodyFacts }> {
  const sealed = await sealCustodySeed(mnemonic, kek);
  // What is sealed must open to the same wallet before anyone relies on it.
  const reopened = await openCustodySeed(sealed, kek);
  const facts = custodyFacts(mnemonic);
  try {
    if (reopened.accountXpub !== facts.accountXpub) throw new DomainError('CUSTODY_MISCONFIGURED', 'the sealed seed does not open to the same wallet');
  } finally {
    reopened.close();
  }
  return { sealed, facts };
}

function printFacts(f: CustodyFacts, out: (s: string) => void): void {
  out(`  INRP2P_CUSTODY_XPUB (web app)      ${f.accountXpub}`);
  out(`  Network budget wallet (TRX)        ${f.budgetWallet}`);
  out(`  Deal-address pool record address   ${f.poolRecordAddress}`);
  out(`  Deal address #0 (for checking)     ${f.firstDealAddress}`);
}

/** A line typed without echo. */
async function hidden(prompt: string): Promise<string> {
  let muted = false;
  const sink = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output: sink, terminal: true });
  try {
    const answer = rl.question(prompt);
    muted = true;
    const value = await answer;
    process.stdout.write('\n');
    return value;
  } finally {
    rl.close();
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  const out = (s: string) => process.stdout.write(`${s}\n`);
  if (command === 'address') {
    const xpub = process.env.INRP2P_CUSTODY_XPUB;
    if (!xpub) throw new Error('INRP2P_CUSTODY_XPUB is not set');
    const index = BigInt(rest[0] ?? '0');
    out(new HdDepositAccount(xpub).addressAt(index).address);
    return;
  }
  if (command === 'new') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('run this on a terminal: the words are shown once and never written anywhere');
    const kek = custodyKekFromEnv(process.env);
    const mnemonic = newCustodyMnemonic();
    const words = mnemonic.split(' ');
    out('\nWrite these 24 words on paper, twice, in order. Keep the two copies in two places, apart from every computer.\n');
    for (let i = 0; i < 24; i += 4) out(`  ${words.slice(i, i + 4).map((w, j) => `${String(i + j + 1).padStart(2)}. ${w.padEnd(10)}`).join(' ')}`);
    await hidden('\nPress Enter when both copies are written. The words will be cleared from the screen. ');
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
    for (const position of confirmationPositions()) {
      const typed = (await hidden(`Word ${position}: `)).trim().toLowerCase();
      if (typed !== words[position - 1]) throw new Error(`word ${position} does not match: nothing was sealed. Run again and write the words carefully.`);
    }
    const { sealed, facts } = await sealNew(mnemonic, kek);
    out('\nSealed under the custody key. Put this in the worker’s secret (INRP2P_CUSTODY_SEED_SEALED) — and only there:\n');
    out(`  ${sealed}\n`);
    out('Public facts — record them; the desk registers the wallet with the first two:');
    printFacts(facts, out);
    out('');
    return;
  }
  if (command === 'verify') {
    const sealed = process.env.INRP2P_CUSTODY_SEED_SEALED;
    if (!sealed) throw new Error('INRP2P_CUSTODY_SEED_SEALED is not set');
    const signer = await openCustodySeed(sealed, custodyKekFromEnv(process.env));
    try {
      out('The sealed seed opens. It is this wallet:');
      printFacts(factsOf(signer), out);
      const web = process.env.INRP2P_CUSTODY_XPUB?.trim();
      if (web) out(web === signer.accountXpub ? 'INRP2P_CUSTODY_XPUB matches.' : 'INRP2P_CUSTODY_XPUB DOES NOT MATCH this seed: the web app would issue addresses this seed does not hold.');
      if (web && web !== signer.accountXpub) process.exitCode = 1;
    } finally {
      signer.close();
    }
    return;
  }
  if (command === 'recover') {
    if (!process.stdin.isTTY) throw new Error('run this on a terminal: the words are typed, never piped or passed');
    const mnemonic = (await hidden('The 24 words, separated by spaces (not shown): ')).trim().toLowerCase().split(/\s+/).join(' ');
    if (!isCustodyMnemonic(mnemonic)) throw new Error('not a valid 24-word seed (a word is wrong or out of order: the checksum fails)');
    const facts = custodyFacts(mnemonic);
    out('These words open this wallet:');
    printFacts(facts, out);
    if (rest.includes('--seal')) {
      const { sealed } = await sealNew(mnemonic, custodyKekFromEnv(process.env));
      out('\nSealed again under the custody key (INRP2P_CUSTODY_SEED_SEALED):\n');
      out(`  ${sealed}`);
    }
    return;
  }
  out('usage: node scripts/custody-seed.ts new | verify | recover [--seal] | address <index>');
  process.exitCode = 2;
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}

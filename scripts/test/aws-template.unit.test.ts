import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AwsKmsKeyEncryptionKey, productionConfigReport } from '@inrp2p/adapters';

/**
 * deploy/aws/inrp2p-aws.json (DEPLOYMENT §10) cannot be deployed from CI, so what can be checked without AWS is checked
 * here: every reference resolves, it makes nothing the owner already made (the KMS key, the Vercel role and its OIDC
 * provider), IAM grants only what the worker uses, the KMS grant is for the owner's key and requires the encryption
 * context the adapter sends, the audit archive is under Object Lock, the worker starts stopped, and the worker's
 * container configuration satisfies the same production contract the worker checks at start.
 */
const OWNER_KEY = 'arn:aws:kms:eu-north-1:075774506744:key/f15dbe8b-22b2-4c22-9775-6ea4b06c2f34';
type Json = Record<string, unknown>;
const template = JSON.parse(readFileSync(path.join(import.meta.dirname, '../../deploy/aws/inrp2p-aws.json'), 'utf8')) as {
  Parameters: Record<string, { Default?: unknown }>; Conditions: Json; Resources: Record<string, { Type: string; Condition?: string; Properties: Json }>; Outputs: Json;
};
const PSEUDO = new Set(['AWS::Region', 'AWS::AccountId', 'AWS::Partition', 'AWS::StackName', 'AWS::URLSuffix', 'AWS::NoValue']);
const known = (name: string) => PSEUDO.has(name) || name in template.Parameters || name in template.Resources;

function walk(node: unknown, visit: (key: string, value: unknown) => void): void {
  if (Array.isArray(node)) node.forEach((n) => walk(n, visit));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) { visit(k, v); walk(v, visit); }
}
const props = (name: string) => template.Resources[name]!.Properties;
/** A role's policies, with a conditional one (`Fn::If`) taken as granted — the stricter reading. */
const policiesOf = (r: { Properties: Json }) =>
  ((r.Properties.Policies ?? []) as Json[]).map((p) => ('Fn::If' in p ? ((p['Fn::If'] as unknown[])[1] as Json) : p)) as { PolicyName: string; PolicyDocument: unknown }[];
const statements = (doc: unknown): Json[] => ((doc as { Statement: Json[] }).Statement);

describe('the AWS template (worker on Fargate, KMS, audit archive, Vercel OIDC role)', () => {
  it('refers only to what it defines', () => {
    const missing: string[] = [];
    walk(template, (k, v) => {
      if (k === 'Ref' && typeof v === 'string' && !known(v)) missing.push(`Ref ${v}`);
      if (k === 'Fn::GetAtt' && Array.isArray(v) && !(String(v[0]) in template.Resources)) missing.push(`GetAtt ${String(v[0])}`);
      if (k === 'Fn::Sub' && typeof v === 'string') for (const [, n] of v.matchAll(/\$\{([^}.]+)(?:\.[^}]+)?\}/g)) if (!known(n!)) missing.push(`Sub ${n}`);
      if (k === 'Condition' && typeof v === 'string' && !(v in template.Conditions)) missing.push(`Condition ${v}`);
    });
    expect(missing).toEqual([]);
  });

  it('makes no KMS key, no Vercel role and no Vercel OIDC provider: the owner made those', () => {
    const types = Object.values(template.Resources).map((r) => r.Type);
    expect(types).not.toContain('AWS::KMS::Key');
    expect(types).not.toContain('AWS::KMS::Alias');
    const oidc = Object.values(template.Resources).filter((r) => r.Type === 'AWS::IAM::OIDCProvider').map((r) => r.Properties.Url);
    expect(oidc).toEqual(['https://token.actions.githubusercontent.com']);
    expect(JSON.stringify(template)).not.toMatch(/oidc\.vercel\.com|inrp2p-vercel-web/);
    expect(template.Parameters.FieldKeyArn!.Default).toBe(OWNER_KEY);
  });

  it('grants the worker only what it uses, and KMS only on the owner’s key, under the adapter’s encryption context', () => {
    const roles = Object.entries(template.Resources).filter(([, r]) => r.Type === 'AWS::IAM::Role');
    const grants = roles.flatMap(([name, r]) => policiesOf(r).flatMap((p) => statements(p.PolicyDocument).map((s) => ({ name, s }))));
    for (const { name, s } of grants) {
      const actions = ([] as string[]).concat(s.Action as string | string[]);
      expect(actions.every((a) => !a.endsWith(':*')), `${name}: ${actions.join(', ')}`).toBe(true);
      if (s.Resource === '*') expect(actions, name).toEqual(['ecr:GetAuthorizationToken']);
      if (actions.some((a) => a.startsWith('kms:')) && (s.Resource as Json).Ref === 'CustodyKeyArn') {
        // The custody seed (ADR 0017): its own key, unwrap only, only under the seed's context — the worker never
        // seals a seed, and the field key cannot open one.
        expect(actions).toEqual(['kms:Decrypt']);
        expect((s.Condition as Json).StringEquals).toEqual({ 'kms:EncryptionContext:app': 'inrp2p', 'kms:EncryptionContext:purpose': 'custody-seed' });
      } else if (actions.some((a) => a.startsWith('kms:'))) {
        expect(actions.sort()).toEqual(['kms:Decrypt', 'kms:Encrypt']);
        expect(s.Resource).toEqual({ Ref: 'FieldKeyArn' });
        expect((s.Condition as Json).StringEquals).toEqual({
          'kms:EncryptionContext:app': AwsKmsKeyEncryptionKey.ENCRYPTION_CONTEXT.app,
          'kms:EncryptionContext:purpose': AwsKmsKeyEncryptionKey.ENCRYPTION_CONTEXT.purpose,
        });
      }
    }
    expect([...new Set(grants.filter((g) => ([] as string[]).concat(g.s.Action as string[]).includes('kms:Decrypt')).map((g) => g.name))]).toEqual(['WorkerTaskRole']);
  });

  it('permits both startup archive checks on the audit bucket only', () => {
    const policies = policiesOf(template.Resources.WorkerTaskRole!);
    const grants = statements(policies.find((p) => p.PolicyName === 'audit-seals')!.PolicyDocument);
    for (const action of ['s3:GetBucketVersioning', 's3:GetBucketObjectLockConfiguration']) {
      const matching = grants.filter((s) => ([] as string[]).concat(s.Action as string | string[]).includes(action));
      expect(matching).toHaveLength(1);
      expect(matching[0]).toMatchObject({
        Effect: 'Allow', Resource: { 'Fn::GetAtt': ['AuditSealBucket', 'Arn'] },
      });
    }
  });

  it('lets only main push the image', () => {
    const [push] = statements(props('ImagePushRole').AssumeRolePolicyDocument);
    expect((push!.Condition as Json).StringLike).toEqual({ 'token.actions.githubusercontent.com:sub': { 'Fn::Sub': 'repo:${GitHubRepository}:ref:refs/heads/main' } });
  });


  it('matches the immutable OIDC subject GitHub issues for this repository, with main and audience scoped exactly', () => {
    const [push] = statements(props('ImagePushRole').AssumeRolePolicyDocument);
    const condition = push!.Condition as { StringEquals: Record<string, string>; StringLike: Record<string, { 'Fn::Sub': string }> };
    const allowedSubject = condition.StringLike['token.actions.githubusercontent.com:sub']!['Fn::Sub']
      .replace('${GitHubRepository}', String(template.Parameters.GitHubRepository!.Default));
    // GitHub's July 2026 immutable-subject contract; owner/repository IDs come from the repository API.
    // https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims
    const mainSubject = 'repo:Gatsby01k@225718825/INRP2PEXC@1373536755:ref:refs/heads/main';
    expect(allowedSubject).toBe(mainSubject);
    expect(allowedSubject).not.toMatch(/[*?]/);
    const accepts = (sub: string, aud = 'sts.amazonaws.com') =>
      sub === allowedSubject && aud === condition.StringEquals['token.actions.githubusercontent.com:aud'];
    expect(accepts(mainSubject)).toBe(true);
    expect(accepts(mainSubject, 'https://github.com/Gatsby01k')).toBe(false);
    for (const rejected of [
      'repo:Gatsby01k/INRP2PEXC:ref:refs/heads/main',
      mainSubject.replace('@225718825/', '@999999999/'),
      mainSubject.replace('@1373536755:', '@999999999:'),
      mainSubject.replace('refs/heads/main', 'refs/heads/feature'),
      mainSubject.replace('ref:refs/heads/main', 'pull_request'),
      mainSubject.replace('ref:refs/heads/main', 'environment:production'),
    ]) expect(accepts(rejected), rejected).toBe(false);
  });

  it('keeps audit seals under Object Lock, versioned, private, TLS only — and retained when the stack goes', () => {
    const b = props('AuditSealBucket');
    expect([b.ObjectLockEnabled, (b.VersioningConfiguration as Json).Status]).toEqual([true, 'Enabled']);
    expect(Object.values(b.PublicAccessBlockConfiguration as Json).every(Boolean)).toBe(true);
    expect((template.Resources.AuditSealBucket as unknown as Json).DeletionPolicy).toBe('Retain');
    expect(JSON.stringify(props('AuditSealBucketPolicy'))).toContain('aws:SecureTransport');
  });

  it('creates the worker stopped, and never runs two during a deployment', () => {
    expect(template.Parameters.DesiredCount!.Default).toBe(0);
    expect(props('WorkerService').DeploymentConfiguration).toMatchObject({ MinimumHealthyPercent: 0, MaximumPercent: 100 });
  });

  it('gives the worker a configuration its own production check accepts', () => {
    const [container] = props('WorkerTask').ContainerDefinitions as { Environment: { Name: string; Value: unknown }[]; Secrets: { Name: string }[] }[];
    const resolve = (v: unknown): string => {
      if (typeof v === 'string') return v;
      const o = v as Json;
      if ('Ref' in o) return o.Ref === 'AWS::Region' ? 'us-east-1' : String(template.Parameters[String(o.Ref)]?.Default ?? `<${String(o.Ref)}>`);
      throw new Error(`unresolved ${JSON.stringify(v)}`);
    };
    const env: NodeJS.ProcessEnv = Object.fromEntries(container!.Environment.map((e) => [e.Name, resolve(e.Value)]));
    // The secrets as the owner fills them in Secrets Manager.
    const secrets: Record<string, string> = {
      WORKER_DATABASE_URL: 'postgresql://inrp2p_worker_login:x@ep-example.us-east-1.aws.neon.tech/neondb?sslmode=require',
      RESEND_API_KEY: 're_from_the_secret_manager', // secret-scan:allow — a placeholder, not a key
      INRP2P_FIELD_HMAC_BASE64: randomBytes(32).toString('base64'), INRP2P_TRON_PRIMARY_KEY: '', INRP2P_CUSTODY_SEED_SEALED: '',
    };
    expect(container!.Secrets.map((s) => s.Name).sort()).toEqual(Object.keys(secrets).sort());
    const report = productionConfigReport('worker', { ...env, ...secrets, AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/task' });
    expect(report.problems).toEqual([]);
    // A second TRON provider and receipt storage are the owner's to add: said out loud, not hidden.
    expect(report.warnings.join('\n')).toMatch(/one TRON provider only[\s\S]*receipts are not stored/);
    // With the custody key and the sealed seed filled in, the signer's configuration is complete too.
    const custody = productionConfigReport('worker', {
      ...env, ...secrets, AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/task',
      INRP2P_CUSTODY_KMS_KEY_ARN: 'arn:aws:kms:us-east-1:075774506744:key/00000000-0000-0000-0000-000000000000', INRP2P_CUSTODY_SEED_SEALED: 'v1.custody-v1.x',
    });
    expect(custody.problems).toEqual([]);
    expect(env.INRP2P_CUSTODY_KEK_ID).toBe('custody-v1');
  });

  it('grants the custody key only once it exists', () => {
    expect(template.Parameters.CustodyKeyArn!.Default).toBe('');
    const custody = (props('WorkerTaskRole').Policies as Json[]).find((p) => 'Fn::If' in p);
    expect((custody!['Fn::If'] as unknown[])[0]).toBe('HasCustodyKey');
  });

  it('never changes the secret\'s placeholder: a stack update would overwrite every value filled in by hand', () => {
    // CloudFormation applies a changed SecretString on the next stack update — the database URL, the Resend and TronGrid
    // keys, the HMAC key and the sealed custody seed would all become SET-ME. The placeholder is only for creating the
    // secret; a key added later (INRP2P_CUSTODY_SEED_SEALED) is added to the secret by hand (DEPLOYMENT §10, §11).
    expect(props('WorkerSecret').SecretString).toBe('{"WORKER_DATABASE_URL":"SET-ME","RESEND_API_KEY":"SET-ME","INRP2P_FIELD_HMAC_BASE64":"SET-ME","INRP2P_TRON_PRIMARY_KEY":""}');
    expect(props('WorkerSecret').Description).toBe('The worker\'s secrets, one JSON object. Fill every SET-ME in the console (Secrets Manager → inrp2p/worker → Retrieve → Edit) before the worker starts; values never go in the template or in chat.');
  });
});

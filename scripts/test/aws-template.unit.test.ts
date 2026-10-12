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
const PSEUDO = new Set(['AWS::Region', 'AWS::AccountId', 'AWS::Partition', 'AWS::StackName', 'AWS::URLSuffix']);
const known = (name: string) => PSEUDO.has(name) || name in template.Parameters || name in template.Resources;

function walk(node: unknown, visit: (key: string, value: unknown) => void): void {
  if (Array.isArray(node)) node.forEach((n) => walk(n, visit));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) { visit(k, v); walk(v, visit); }
}
const props = (name: string) => template.Resources[name]!.Properties;
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
    const grants = roles.flatMap(([name, r]) => ((r.Properties.Policies ?? []) as { PolicyDocument: unknown }[]).flatMap((p) => statements(p.PolicyDocument).map((s) => ({ name, s }))));
    for (const { name, s } of grants) {
      const actions = ([] as string[]).concat(s.Action as string | string[]);
      expect(actions.every((a) => !a.endsWith(':*')), `${name}: ${actions.join(', ')}`).toBe(true);
      if (s.Resource === '*') expect(actions, name).toEqual(['ecr:GetAuthorizationToken']);
      if (actions.some((a) => a.startsWith('kms:'))) {
        expect(actions.sort()).toEqual(['kms:Decrypt', 'kms:Encrypt']);
        expect(s.Resource).toEqual({ Ref: 'FieldKeyArn' });
        expect((s.Condition as Json).StringEquals).toEqual({
          'kms:EncryptionContext:app': AwsKmsKeyEncryptionKey.ENCRYPTION_CONTEXT.app,
          'kms:EncryptionContext:purpose': AwsKmsKeyEncryptionKey.ENCRYPTION_CONTEXT.purpose,
        });
      }
    }
    expect(grants.filter((g) => ([] as string[]).concat(g.s.Action as string[]).includes('kms:Decrypt')).map((g) => g.name)).toEqual(['WorkerTaskRole']);
  });

  it('lets only main push the image', () => {
    const [push] = statements(props('ImagePushRole').AssumeRolePolicyDocument);
    expect((push!.Condition as Json).StringLike).toEqual({ 'token.actions.githubusercontent.com:sub': { 'Fn::Sub': 'repo:${GitHubRepository}:ref:refs/heads/main' } });
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
      INRP2P_FIELD_HMAC_BASE64: randomBytes(32).toString('base64'), INRP2P_TRON_PRIMARY_KEY: '',
    };
    expect(container!.Secrets.map((s) => s.Name).sort()).toEqual(Object.keys(secrets).sort());
    const report = productionConfigReport('worker', { ...env, ...secrets, AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/task' });
    expect(report.problems).toEqual([]);
    // A second TRON provider and receipt storage are the owner's to add: said out loud, not hidden.
    expect(report.warnings.join('\n')).toMatch(/one TRON provider only[\s\S]*receipts are not stored/);
  });
});

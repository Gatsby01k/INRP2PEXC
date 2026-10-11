import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AwsKmsKeyEncryptionKey, productionConfigReport } from '@inrp2p/adapters';

/**
 * deploy/aws/inrp2p-aws.json (DEPLOYMENT §10) cannot be deployed from CI, so what can be checked without AWS is checked
 * here: every reference resolves, IAM grants only what the processes use, the KMS grants require the encryption context
 * the adapter sends, the audit archive is under Object Lock, the worker starts stopped, and the worker's container
 * configuration satisfies the same production contract the worker checks at start.
 */
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
const subbed = (s: string) => s.replace(/\$\{([^}]+)\}/g, (_, n: string) => `<${n}>`);

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

  it('grants the processes only what they use, and KMS only under the adapter’s encryption context', () => {
    const roles = Object.entries(template.Resources).filter(([, r]) => r.Type === 'AWS::IAM::Role');
    const grants = roles.flatMap(([name, r]) => ((r.Properties.Policies ?? []) as { PolicyDocument: unknown }[]).flatMap((p) => statements(p.PolicyDocument).map((s) => ({ name, s }))));
    for (const { name, s } of grants) {
      const actions = ([] as string[]).concat(s.Action as string | string[]);
      expect(actions.every((a) => !a.endsWith(':*')), `${name}: ${actions.join(', ')}`).toBe(true);
      if (s.Resource === '*') expect(actions, name).toEqual(['ecr:GetAuthorizationToken']);
      if (actions.some((a) => a.startsWith('kms:'))) {
        expect(actions.sort()).toEqual(['kms:Decrypt', 'kms:Encrypt']);
        expect((s.Condition as Json).StringEquals).toEqual({
          'kms:EncryptionContext:app': AwsKmsKeyEncryptionKey.ENCRYPTION_CONTEXT.app,
          'kms:EncryptionContext:purpose': AwsKmsKeyEncryptionKey.ENCRYPTION_CONTEXT.purpose,
        });
      }
    }
    expect(grants.filter((g) => ([] as string[]).concat(g.s.Action as string[]).includes('kms:Decrypt')).map((g) => g.name).sort()).toEqual(['VercelWebRole', 'WorkerTaskRole']);
    expect(props('FieldKey').EnableKeyRotation).toBe(true);
  });

  it('lets only the Vercel project’s production deployments assume the web role, and only main push the image', () => {
    const doc = JSON.parse(subbed((props('VercelWebRole').AssumeRolePolicyDocument as { 'Fn::Sub': string })['Fn::Sub'])) as Json;
    const [s] = statements(doc);
    expect(s!.Action).toBe('sts:AssumeRoleWithWebIdentity');
    expect((s!.Condition as Json).StringEquals).toEqual({
      'oidc.vercel.com/<VercelTeamSlug>:aud': 'https://vercel.com/<VercelTeamSlug>',
      'oidc.vercel.com/<VercelTeamSlug>:sub': 'owner:<VercelTeamSlug>:project:<VercelProjectName>:environment:production',
    });
    const [push] = statements(props('ImagePushRole').AssumeRolePolicyDocument);
    expect((push!.Condition as Json).StringLike).toEqual({ 'token.actions.githubusercontent.com:sub': { 'Fn::Sub': 'repo:${GitHubRepository}:ref:refs/heads/main' } });
  });

  it('keeps audit seals under Object Lock, versioned, private, TLS only — and retained when the stack goes', () => {
    const b = props('AuditSealBucket');
    expect([b.ObjectLockEnabled, (b.VersioningConfiguration as Json).Status]).toEqual([true, 'Enabled']);
    expect(Object.values(b.PublicAccessBlockConfiguration as Json).every(Boolean)).toBe(true);
    expect((template.Resources.AuditSealBucket as unknown as Json).DeletionPolicy).toBe('Retain');
    expect((template.Resources.FieldKey as unknown as Json).DeletionPolicy).toBe('Retain');
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
      if ('Fn::GetAtt' in o) return 'arn:aws:kms:us-east-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab';
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

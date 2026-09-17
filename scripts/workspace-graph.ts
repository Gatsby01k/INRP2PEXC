/**
 * Workspace dependency graph check. Fails when:
 *  - any cycle exists across dependencies, devDependencies, optionalDependencies or peerDependencies
 *    between workspace packages (dev edges count: pnpm links them and cycles break install ordering);
 *  - a package under packages/ depends on an app under apps/;
 *  - a workspace dependency does not use the `workspace:` protocol.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export interface WorkspaceManifest {
  name: string;
  dir: string;
  deps: Record<string, string>;
}

const FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

export function loadWorkspace(root: string): WorkspaceManifest[] {
  const dirs = ['packages', 'apps'].flatMap((d) => (existsSync(path.join(root, d)) ? readdirSync(path.join(root, d)).map((p) => path.join(d, p)) : []));
  return dirs
    .filter((d) => existsSync(path.join(root, d, 'package.json')))
    .map((d) => {
      const pkg = JSON.parse(readFileSync(path.join(root, d, 'package.json'), 'utf8'));
      const deps: Record<string, string> = {};
      for (const f of FIELDS) Object.assign(deps, pkg[f] ?? {});
      return { name: pkg.name as string, dir: d, deps };
    });
}

export function checkGraph(manifests: WorkspaceManifest[]): { problems: string[]; order: string[] } {
  const byName = new Map(manifests.map((m) => [m.name, m]));
  const problems: string[] = [];
  const edges = new Map<string, string[]>();
  for (const m of manifests) {
    const out: string[] = [];
    for (const [dep, spec] of Object.entries(m.deps)) {
      const target = byName.get(dep);
      if (!target) continue;
      if (!spec.startsWith('workspace:')) problems.push(`${m.name} -> ${dep} must use the workspace: protocol (found ${spec})`);
      if (m.dir.startsWith('packages') && target.dir.startsWith('apps')) problems.push(`${m.name} (package) must not depend on app ${dep}`);
      out.push(dep);
    }
    edges.set(m.name, out.sort());
  }

  const state = new Map<string, 'visiting' | 'done'>();
  const order: string[] = [];
  const stack: string[] = [];
  const visit = (n: string) => {
    if (state.get(n) === 'done') return;
    if (state.get(n) === 'visiting') {
      const cycle = [...stack.slice(stack.indexOf(n)), n];
      problems.push(`workspace dependency cycle: ${cycle.join(' -> ')}`);
      return;
    }
    state.set(n, 'visiting');
    stack.push(n);
    for (const d of edges.get(n) ?? []) visit(d);
    stack.pop();
    state.set(n, 'done');
    order.push(n);
  };
  for (const n of [...edges.keys()].sort()) visit(n);
  return { problems, order };
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dirname, '..');
  const manifests = loadWorkspace(root);
  const { problems, order } = checkGraph(manifests);
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(`workspace graph acyclic (${manifests.length} packages); topological order:`);
  for (const n of order) {
    const deps = Object.keys(manifests.find((m) => m.name === n)!.deps).filter((d) => d.startsWith('@inrp2p/'));
    console.log(`  ${n}${deps.length ? ` <- ${deps.join(', ')}` : ''}`);
  }
}

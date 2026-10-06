/**
 * Workspace dependency graph check. Fails when:
 *  - any cycle exists across dependencies, devDependencies, optionalDependencies or peerDependencies
 *    between workspace packages (dev edges count: pnpm links them and cycles break install ordering);
 *  - a package under packages/ depends on an app under apps/;
 *  - a workspace dependency does not use the `workspace:` protocol;
 *  - a package's own source imports a package its manifest does not list in `dependencies` (or `peerDependencies`).
 *    The images install production dependencies only (`pnpm install --prod`), so an import satisfied in development
 *    by a devDependency — or by the root manifest, which lists every workspace package — fails only in production:
 *    the worker image could not start for exactly this reason (production task E4).
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

const IMPORTS = [
  /^\s*import\s+(?:type\s+)?(?:[\w$]+\s*,?\s*)?(?:\*\s+as\s+[\w$]+|\{[^}]*\})?\s*(?:from\s*)?['"]([^'"]+)['"]/gm,
  /^\s*import\s+[\w$]+\s+from\s*['"]([^'"]+)['"]/gm,
  /^\s*export\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s*['"]([^'"]+)['"]/gm,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** The bare package names a source file imports (`node:` built-ins and relative paths aside). */
export function importedPackages(source: string): string[] {
  const names = new Set<string>();
  for (const re of IMPORTS) {
    for (const m of source.matchAll(re)) {
      const spec = m[1]!;
      if (spec.startsWith('node:') || spec.startsWith('.') || spec.startsWith('/')) continue;
      names.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!);
    }
  }
  return [...names].sort();
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    // Test helpers (`src/testing`) and tests are not loaded by a production process.
    if (e.isDirectory()) return ['node_modules', '.next', 'testing'].includes(e.name) ? [] : sourceFiles(p);
    return /\.(ts|tsx|mts)$/.test(e.name) && !/\.(test|spec|stories)\./.test(e.name) ? [p] : [];
  });
}

/** Every import of a package's production source that its manifest does not list where a production install looks. */
export function undeclaredImports(root: string): string[] {
  const problems: string[] = [];
  for (const m of loadWorkspace(root)) {
    const pkg = JSON.parse(readFileSync(path.join(root, m.dir, 'package.json'), 'utf8'));
    const runtime = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]);
    const dev = new Set(Object.keys(pkg.devDependencies ?? {}));
    const seen = new Set<string>();
    for (const file of sourceFiles(path.join(root, m.dir, 'src'))) {
      for (const name of importedPackages(readFileSync(file, 'utf8'))) {
        if (name === m.name || runtime.has(name) || seen.has(name)) continue;
        seen.add(name);
        problems.push(`${m.name} imports ${name} in ${path.relative(root, file)} but ${dev.has(name) ? 'lists it only in devDependencies, which a production install leaves out' : 'does not list it in dependencies'}`);
      }
    }
  }
  return problems.sort();
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dirname, '..');
  const manifests = loadWorkspace(root);
  const graph = checkGraph(manifests);
  const order = graph.order;
  const problems = [...graph.problems, ...undeclaredImports(root)];
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

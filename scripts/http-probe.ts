import { request } from 'node:http';

/**
 * One HTTP request to a process on this machine, as if it had arrived for `host` through the TLS load balancer.
 *
 * Not `fetch`: Node's fetch replaces a Host header the caller sets with the address it connects to, so every
 * request reached the web app as `127.0.0.1:<port>` — the host checks were never exercised, and the monitoring
 * token, which the desk host alone accepts, was refused (CI run 37984058597, `images`). The app tells its three
 * surfaces apart by Host, so a probe of them has to send one.
 */
export function probe(port: number | string, path: string, host: string, headers: Record<string, string> = {}): Promise<{ code: number; body: string }> {
  return new Promise((resolve) => {
    const req = request({ hostname: '127.0.0.1', port: Number(port), path, headers: { host, 'x-forwarded-proto': 'https', ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ code: res.statusCode ?? 0, body }));
    });
    req.setTimeout(10_000, () => req.destroy());
    req.on('error', () => resolve({ code: 0, body: '' }));
    req.end();
  });
}

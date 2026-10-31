import net from 'node:net';

/**
 * A phone in India reaching this product on Vercel, as a TCP proxy in front of the built app (test-only).
 *
 * On Vercel a visitor's connection ends at the edge nearest them (Mumbai); what the edge cannot answer itself — a page,
 * a router payload, an action — goes on to the functions' region (`iad1`), where the database is, and back. So:
 *
 * - a new connection pays its handshakes with the edge (TCP and TLS 1.3: two round trips of the last mile);
 * - every request pays one round trip of the last mile, and the link's bandwidth both ways;
 * - every request but a static asset (`/_next/static`, `/_next/image`) also pays the round trip from the edge to the
 *   functions' region and back.
 *
 * It is a model, stated rather than measured: the figures are public ones for the last mile (Lighthouse's own "Slow 4G",
 * a good Indian 4G connection) and ADR 0021's Mumbai → us-east-1 round trip. Chrome speaks HTTP/1.1 to a plain-http
 * origin without pipelining, so requests and responses alternate on a connection and each response can be matched to
 * its request.
 *
 * The harness tells its three surfaces apart by port, so the proxy hands the server the `Host` the server is listening
 * as (the same length, so no header or body length changes). It is meant for page loads and router requests: what the
 * browser is sent back names the server's own port, so a redirect or a link leaves the proxy.
 */
export interface Network {
  /** Round trip from the phone to the nearest edge, ms. */
  readonly lastMile: number;
  /** Round trip from the edge to the functions' region, ms. */
  readonly origin: number;
  /** Bytes per second, down and up. */
  readonly down: number;
  readonly up: number;
}

export const NETWORKS = {
  /** Lighthouse's mobile "Slow 4G" last mile — 150 ms, 1.6 Mbps down, 750 kbps up — and Mumbai → iad1. */
  'india-slow-4g': { lastMile: 150, origin: 190, down: 1.6e6 / 8, up: 750e3 / 8 },
  /** A good Indian 4G connection: about 60 ms to the edge, 12 Mbps down, 4 Mbps up — and Mumbai → iad1. */
  'india-4g': { lastMile: 60, origin: 190, down: 12e6 / 8, up: 4e6 / 8 },
} as const satisfies Record<string, Network>;

export type NetworkName = keyof typeof NETWORKS;

const STATIC = /^[A-Z]+ \/_next\/(static|image)\//;

/** Starts a proxy on `listen` in front of the server on `target`; resolves to the function that stops it. */
export function shapedProxy(listen: number, target: number, network: Network): Promise<() => void> {
  const from = Buffer.from(`127.0.0.1:${listen}`);
  const to = Buffer.from(`127.0.0.1:${target}`);
  if (from.length !== to.length) throw new Error('the proxy port must have as many digits as the server port');
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(target, '127.0.0.1');
    sockets.add(client).add(upstream);
    const opened = performance.now();
    const viaOrigin: boolean[] = [];
    const toServer = new Line(upstream);
    const toPhone = new Line(client);
    let upFree = 0;
    let downFree = 0;
    client.on('data', (chunk: Buffer) => {
      const head = chunk.subarray(0, 64).toString('latin1');
      if (/^[A-Z]+ \//.test(head)) viaOrigin.push(!STATIC.test(head));
      const out = replaceAll(chunk, from, to);
      upFree = Math.max(upFree, performance.now(), opened + 2 * network.lastMile) + (out.length / network.up) * 1000;
      toServer.send(out, upFree + network.lastMile / 2);
    });
    upstream.on('data', (chunk: Buffer) => {
      const extra = chunk.subarray(0, 8).toString('latin1') === 'HTTP/1.1' && viaOrigin.shift() ? network.origin : 0;
      downFree = Math.max(downFree, performance.now() + extra) + (chunk.length / network.down) * 1000;
      toPhone.send(chunk, downFree + network.lastMile / 2);
    });
    const close = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on('end', () => toServer.end());
    upstream.on('end', () => toPhone.end());
    client.on('error', close);
    upstream.on('error', close);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listen, '127.0.0.1', () =>
      resolve(() => {
        for (const s of sockets) s.destroy();
        server.close();
      }),
    );
  });
}

/**
 * One direction of a connection: bytes delivered in the order they were sent, each no sooner than its time. One timer
 * for the head of the line — timers of different lengths may fire out of order, and a byte stream may not.
 */
class Line {
  private readonly queue: { at: number; chunk: Buffer | null }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly socket: net.Socket;
  constructor(socket: net.Socket) {
    this.socket = socket;
  }

  send(chunk: Buffer, at: number): void {
    this.push({ at: Math.max(at, this.queue.at(-1)?.at ?? 0), chunk });
  }

  /** The other side finished: finish this one too, once everything sent before has been delivered. */
  end(): void {
    this.push({ at: this.queue.at(-1)?.at ?? 0, chunk: null });
  }

  private push(item: { at: number; chunk: Buffer | null }): void {
    this.queue.push(item);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.queue.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const now = performance.now();
      while (this.queue.length && this.queue[0]!.at <= now + 0.5) {
        const { chunk } = this.queue.shift()!;
        if (this.socket.destroyed) continue;
        if (chunk) this.socket.write(chunk);
        else this.socket.end();
      }
      this.schedule();
    }, Math.max(0, this.queue[0]!.at - performance.now()));
  }
}

function replaceAll(chunk: Buffer, from: Buffer, to: Buffer): Buffer {
  let at = chunk.indexOf(from);
  if (at < 0) return chunk;
  const out = Buffer.from(chunk);
  while (at >= 0) {
    to.copy(out, at);
    at = out.indexOf(from, at + from.length);
  }
  return out;
}

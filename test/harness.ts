// Loopback HTTP server used by the network tests. Production defaults are not weakened: the tests reach
// it only through the injectable resolver and the testAllowHosts option of fetchUrl.

import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import type { FetchOptions, Resolver } from '../src/fetch.js';

export const HTML_PAGE = `<!DOCTYPE html><html><head><title>T</title></head><body><nav><a href="/">Home</a></nav><main><h1>Hello agents</h1><p>Price 490 € per audit. See <a href="/pricing">pricing</a>.</p></main><footer>f</footer></body></html>`;
export const MD_PAGE = `# Hello agents\n\nPrice 490 € per audit. See [pricing](/pricing).\n`;
export const MD_PAGE_CHANGED = `# Hello agents\n\nPrice 590 € per audit. See [pricing](/prices).\n`;

export interface Harness {
  server: http.Server;
  port: number;
  host: string;
  url: (p: string) => string;
  options: (accept: string, extra?: Partial<FetchOptions>) => FetchOptions;
  close: () => Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const host = 'parity.test';
  const server = http.createServer((req, res) => {
    const accept = req.headers['accept'] ?? '';
    const wantsMd = accept.includes('text/markdown');
    const url = new URL(req.url ?? '/', 'http://x');
    const sendMd = (body: string) => {
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
      res.end(body);
    };
    const sendHtml = () => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML_PAGE);
    };
    switch (url.pathname) {
      case '/ok':
        return wantsMd ? sendMd(MD_PAGE) : sendHtml();
      case '/changed':
        return wantsMd ? sendMd(MD_PAGE_CHANGED) : sendHtml();
      case '/explicit.md':
        return sendMd(MD_PAGE);
      case '/html-only':
        return sendHtml();
      case '/plain':
        if (!wantsMd) return sendHtml();
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(MD_PAGE);
      case '/json':
        if (!wantsMd) return sendHtml();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end('{}');
      case '/md-500':
        if (!wantsMd) return sendHtml();
        res.writeHead(500, { 'Content-Type': 'text/html' });
        return res.end('<html><body>Internal error</body></html>');
      case '/404':
        res.writeHead(404, { 'Content-Type': 'text/html' });
        return res.end('<html><body>Not found</body></html>');
      case '/slow':
        return; // never answers
      case '/trickle': {
        // Keeps the socket busy with a small chunk every 25 ms for about 400 ms.
        res.writeHead(200, { 'Content-Type': 'text/markdown' });
        let n = 0;
        const t = setInterval(() => {
          res.write('# a\n');
          if (++n >= 16) {
            clearInterval(t);
            res.end();
          }
        }, 25);
        res.on('close', () => clearInterval(t));
        return;
      }
      case '/big': {
        res.writeHead(200, { 'Content-Type': 'text/markdown' });
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        let sent = 0;
        const push = () => {
          while (sent < 4 * 1024 * 1024) {
            sent += chunk.length;
            if (!res.write(chunk)) return void res.once('drain', push);
          }
          res.end();
        };
        return push();
      }
      case '/big-gzip': {
        // 20 KiB compressed body that decodes to 2 MiB: the cap must apply to decoded bytes.
        const gz = zlib.gzipSync(Buffer.alloc(2 * 1024 * 1024, 0x61));
        res.writeHead(200, { 'Content-Type': 'text/markdown', 'Content-Encoding': 'gzip', 'Content-Length': String(gz.length) });
        return res.end(gz);
      }
      case '/gzip': {
        const gz = zlib.gzipSync(Buffer.from(MD_PAGE));
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Encoding': 'gzip' });
        return res.end(gz);
      }
      case '/loop':
        res.writeHead(302, { Location: '/loop2' });
        return res.end();
      case '/loop2':
        res.writeHead(302, { Location: '/loop' });
        return res.end();
      case '/many': {
        const n = Number(url.searchParams.get('n') ?? '0');
        res.writeHead(301, { Location: `/many?n=${n + 1}` });
        return res.end();
      }
      case '/redirect-ok':
        res.writeHead(307, { Location: '/ok' });
        return res.end();
      case '/to-private':
        res.writeHead(302, { Location: 'http://10.0.0.1/secret' });
        return res.end();
      case '/to-loopback-name':
        res.writeHead(302, { Location: 'http://localhost/secret' });
        return res.end();
      case '/to-file':
        res.writeHead(302, { Location: 'file:///etc/passwd' });
        return res.end();
      case '/to-creds':
        res.writeHead(302, { Location: `http://user:pw@${host}:${(server.address() as AddressInfo).port}/ok` });
        return res.end();
      default:
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('nope');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const resolver: Resolver = async (hostname) => {
    if (hostname === host) return [{ address: '127.0.0.1', family: 4 }];
    if (hostname === 'private-name.test') return [{ address: '192.168.1.10', family: 4 }];
    if (hostname === 'mixed-name.test') return [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }];
    if (hostname === 'v6-loopback.test') return [{ address: '::1', family: 6 }];
    if (hostname === 'v6-mapped.test') return [{ address: '::ffff:10.0.0.1', family: 6 }];
    if (hostname === 'public-name.test') return [{ address: '93.184.216.34', family: 4 }];
    if (hostname === 'slow-dns.test') return new Promise((resolve) => setTimeout(() => resolve([{ address: '93.184.216.34', family: 4 }]), 400));
    throw new Error(`ENOTFOUND ${hostname}`);
  };
  return {
    server,
    port,
    host,
    url: (p) => `http://${host}:${port}${p}`,
    options: (accept, extra = {}) => ({ accept, timeoutMs: 3000, maxBytes: 1024 * 1024, resolver, testAllowHosts: [host], ...extra }),
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

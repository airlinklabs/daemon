// This code was written by thavanish(https://github.com/thavanish) for airlinklabs
import { buildGuiHtml } from './loader';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export async function runDevGui(port = 3000): Promise<void> {
  const guiHtml = buildGuiHtml(true);

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === '/') {
        return new Response(guiHtml, {
          headers: { 'Content-Type': 'text/html' }
        });
      }

      if (url.pathname.startsWith('/api/')) {
        const fn = url.pathname.slice(5); // remove /api/
        const args = await req.json().catch(() => []);

        let result: any;

        switch (fn) {
          case 'getDaemonStatus':
            // Check if daemon is running by trying to connect to port 3002
            try {
              const response = await fetch('http://localhost:3002/api/status', { method: 'GET' });
              result = { running: response.ok };
            } catch {
              result = { running: false };
            }
            break;

          case 'stopDaemon':
            // Cannot stop external daemon, just return ok
            result = { ok: true };
            break;

          case 'pollLogs':
            const since = parseInt(args[0], 10) || 0;
            const logPath = join(process.cwd(), 'logs/combined.log');
            try {
              const fileLines = existsSync(logPath)
                ? readFileSync(logPath, 'utf-8').split('\n').filter(Boolean)
                : [];
              const slice = fileLines.slice(since);
              result = { lines: slice, next: fileLines.length };
            } catch {
              result = { lines: [], next: since };
            }
            break;

          case 'getSystemStats':
            const { cpus, freemem, totalmem } = await import('node:os');
            const before = cpus();
            await new Promise<void>((r) => setTimeout(r, 200));
            const after = cpus();
            let idle = 0;
            let total = 0;
            for (let i = 0; i < before.length; i++) {
              const b = before[i].times;
              const a = after[i].times;
              idle += a.idle - b.idle;
              total += (a.idle + a.user + a.nice + a.sys + a.irq) - (b.idle + b.user + b.nice + b.sys + b.irq);
            }
            const cpuUsage = total > 0 ? (1 - idle / total) * 100 : 0;
            const memUsage = Number(totalmem) - Number(freemem);
            result = {
              cpu: Math.round(cpuUsage * 100) / 100,
              mem: memUsage,
              memTotal: Number(totalmem),
              uptime: process.uptime()
            };
            break;

          default:
            result = { error: 'Unknown function' };
        }

        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response('Not Found', { status: 404 });
    }
  });

  console.log(`[dev-gui] Server running at http://localhost:${port}`);
}
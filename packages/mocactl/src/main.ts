import { main } from './cli.js';

const ac = new AbortController();
process.once('SIGINT', () => ac.abort());

const code = await main(
  process.argv.slice(2),
  process.env,
  { out: (s) => void process.stdout.write(s), err: (s) => void process.stderr.write(s + '\n') },
  {
    signal: ac.signal,
    stdinIsTTY: process.stdin.isTTY === true,
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    },
    // Loaded lazily so the headless commands never load Ink or React.
    startInteractive: async (rt, opts) => (await import('./start.js')).startInteractive(rt, opts),
  },
);
// After a Ctrl-C, a listing or a stdin read may still be pending (they are abandoned, not
// stopped), and either would keep the process alive; exit once stdout has drained.
if (ac.signal.aborted) process.stdout.write('', () => process.exit(code));
else process.exitCode = code;

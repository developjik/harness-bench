/** Process spawning with a hard timeout and output caps. */

import { spawn } from 'node:child_process';
import { truncateTail } from '../util.js';

export interface SpawnOptions {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

export interface SpawnOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

const CAP = 300_000;

export async function spawnProcess(command: string, args: string[], options: SpawnOptions): Promise<SpawnOutcome> {
  const started = Date.now();
  return new Promise<SpawnOutcome>((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: true,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (stdout.length < CAP) stdout += text;
      options.onOutput?.('stdout', text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (stderr.length < CAP) stderr += text;
      options.onOutput?.('stderr', text);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, Math.max(1_000, options.timeoutMs));

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: timedOut ? null : code,
        stdout: truncateTail(stdout, CAP),
        stderr: truncateTail(stderr, CAP),
        timedOut,
        durationMs: Date.now() - started,
      });
    };

    child.on('error', (error) => {
      stderr += `${String(error)}\n`;
      options.onOutput?.('stderr', `${String(error)}\n`);
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

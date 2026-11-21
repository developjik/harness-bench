/** A driver for any harness CLI: binary + argument builder + availability check. */

import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { DriverContext, DriverOutcome, HarnessDriver } from './types.js';
import { spawnProcess } from './spawn.js';

export interface CliDriverSpec {
  id: string;
  label: string;
  binary: string;
  /** Environment variable that overrides the binary path. */
  envVar: string;
  /** Builds the argv for a run, without the binary itself. */
  args: (ctx: DriverContext) => string[];
  /** Non-interactive one-liner for docs and dry-run output. */
  example: string;
}

export function whichBinary(binary: string): string | null {
  if (binary.includes('/')) {
    try {
      accessSync(binary, constants.X_OK);
      return binary;
    } catch {
      return null;
    }
  }
  const paths = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of paths) {
    const candidate = join(dir, binary);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function abbreviatedPrompt(prompt: string, max = 60): string {
  const flat = prompt.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

export function createCliDriver(spec: CliDriverSpec): HarnessDriver {
  const resolveBinary = (env: NodeJS.ProcessEnv): string => (env[spec.envVar] as string | undefined) ?? spec.binary;

  return {
    id: spec.id,
    label: spec.label,
    kind: 'cli',
    commandLine(ctx) {
      const binary = resolveBinary(ctx.env);
      const args = [...spec.args({ ...(ctx as DriverContext), extraArgs: ctx.extraArgs }), ...ctx.extraArgs];
      const display = args.map((arg) => (arg.includes('\n') ? shellQuote(abbreviatedPrompt(arg, 40)) : shellQuote(arg)));
      return [shellQuote(binary), ...display].join(' ');
    },
    async available() {
      if (process.env[spec.envVar]) return whichBinary(process.env[spec.envVar] as string) !== null;
      return whichBinary(spec.binary) !== null;
    },
    async run(ctx: DriverContext): Promise<DriverOutcome> {
      const binary = resolveBinary(ctx.env);
      const args = [...spec.args(ctx), ...ctx.extraArgs];
      const commandLine = this.commandLine(ctx);
      if (ctx.dryRun) {
        ctx.onOutput?.('stdout', `[dry-run] would execute: ${commandLine}\n`);
        return {
          exitCode: 0,
          stdout: `[dry-run] ${commandLine}\n`,
          stderr: '',
          wallClockMs: 0,
          timedOut: false,
          simulated: true,
          commandLine,
          note: 'dry-run: harness process was not started',
        };
      }
      if (whichBinary(binary) === null) {
        return {
          exitCode: 127,
          stdout: '',
          stderr: `harness binary not found: ${binary}\n`,
          wallClockMs: 0,
          timedOut: false,
          commandLine,
          note: `binary not found: ${binary} (set ${spec.envVar} to point at it)`,
        };
      }
      const outcome = await spawnProcess(binary, args, {
        cwd: ctx.cwd,
        timeoutMs: ctx.timeoutMs,
        env: ctx.env,
        onOutput: ctx.onOutput,
      });
      return {
        exitCode: outcome.code,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        wallClockMs: outcome.durationMs,
        timedOut: outcome.timedOut,
        commandLine,
        note: outcome.timedOut ? `timed out after ${ctx.timeoutMs}ms` : undefined,
      };
    },
  };
}

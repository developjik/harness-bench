import { createCliDriver } from './cli.js';
import type { HarnessDriver } from './types.js';

/** Claude Code (Anthropic): `claude -p "<prompt>"`. */
export const claudeCodeDriver: HarnessDriver = createCliDriver({
  id: 'claude-code',
  label: 'Claude Code',
  binary: 'claude',
  envVar: 'HARNESS_CLAUDE_CMD',
  example: 'claude -p "<prompt>" --permission-mode acceptEdits',
  args: (ctx) => ['-p', ctx.prompt, '--output-format', 'text', '--permission-mode', 'acceptEdits'],
});

/** Codex CLI (OpenAI): `codex exec --full-auto "<prompt>"`. */
export const codexDriver: HarnessDriver = createCliDriver({
  id: 'codex',
  label: 'Codex CLI',
  binary: 'codex',
  envVar: 'HARNESS_CODEX_CMD',
  example: 'codex exec --full-auto "<prompt>"',
  args: (ctx) => ['exec', '--full-auto', '--color', 'never', ctx.prompt],
});

/** OpenCode: `opencode run "<prompt>"`. */
export const opencodeDriver: HarnessDriver = createCliDriver({
  id: 'opencode',
  label: 'OpenCode',
  binary: 'opencode',
  envVar: 'HARNESS_OPENCODE_CMD',
  example: 'opencode run "<prompt>"',
  args: (ctx) => ['run', ctx.prompt],
});

/**
 * Damon (damon-agent-core): `damon prompt "<prompt>" --backend <id>`.
 * Damon relays the turn to the backend CLI it drives; the backend defaults to `claude`
 * and can be changed with HARNESS_DAMON_BACKEND or --damon-backend.
 */
export const damonDriver: HarnessDriver = createCliDriver({
  id: 'damon',
  label: 'Damon',
  binary: 'damon',
  envVar: 'HARNESS_DAMON_CMD',
  example: 'damon prompt "<prompt>" --backend claude',
  args: (ctx) => {
    const backend = ctx.env.HARNESS_DAMON_BACKEND ?? 'claude';
    return ['prompt', ctx.prompt, '--backend', backend];
  },
});

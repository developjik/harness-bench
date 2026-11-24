import { win32 } from 'node:path';
import { runGit } from './git.js';

/** Portable relative Git paths, safe to materialize on POSIX and Windows. */
export function safeSelectionPath(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && s.length < 4096 && !s.includes('\\') && !/[\x00-\x1f:]/.test(s) && !s.startsWith('/') && !win32.isAbsolute(s) && !s.split('/').some(p => p === '..' || p === '.' || p === '' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p));
}
export function assertFullSelectionClone(repo: string): void {
  const legacy = runGit(repo, ['config', '--get', 'extensions.partialClone']);
  const flags = runGit(repo, ['config', '--type=bool', '--get-regexp', '^remote\\..*\\.promisor$']);
  // Exit 1 means the setting is absent. Other errors must not masquerade as a full clone.
  if (![0, 1].includes(legacy.code ?? -1) || ![0, 1].includes(flags.code ?? -1)) throw new Error('cannot verify full clone configuration');
  if (legacy.stdout.trim() || flags.stdout.split('\n').some(line => /\s+true\s*$/.test(line))) throw new Error('offline selection requires a full clone, not a partial/promisor clone');
}

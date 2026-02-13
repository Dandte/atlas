// ═══════════════════════════════════════
// ATLAS — Git Tool
// Git operations on local repositories
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../types';
import logger from '../../utils/logger';
import simpleGit, { SimpleGit } from 'simple-git';

// Operations that modify the repo and need approval
const DANGEROUS_OPS = ['commit', 'push'];

export class GitTool implements Tool {
  definition = {
    name: 'git',
    description: 'Execute git operations on a repository. Supports: status, log, diff, add, commit, push, pull, branch, checkout. Commit and push require user approval.',
    input_schema: {
      type: 'object' as const,
      properties: {
        operation: {
          type: 'string',
          enum: ['status', 'log', 'diff', 'add', 'commit', 'push', 'pull', 'branch', 'checkout'],
          description: 'Git operation to perform',
        },
        path: {
          type: 'string',
          description: 'Path to the repository (default: current directory)',
        },
        args: {
          type: 'string',
          description: 'Additional arguments (e.g., commit message, branch name, number of log entries)',
        },
      },
      required: ['operation'],
    },
    // Dynamic: commit and push are dangerous, handled in execute
    dangerous: false,
  };

  // Override: check if the specific operation is dangerous
  get isDangerousOperation(): boolean {
    return false; // Handled per-operation in executor override
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const operation = params.operation as string;
    const repoPath = (params.path as string) || process.cwd();
    const args = (params.args as string) || '';

    try {
      const git: SimpleGit = simpleGit(repoPath);

      // Verify it's a git repo
      const isRepo = await git.checkIsRepo();
      if (!isRepo) {
        return { success: false, output: '', error: `${repoPath} no es un repositorio git` };
      }

      switch (operation) {
        case 'status': {
          const status = await git.status();
          const lines: string[] = [];
          lines.push(`Branch: ${status.current ?? 'unknown'}`);
          if (status.tracking) lines.push(`Tracking: ${status.tracking}`);
          if (status.ahead > 0) lines.push(`Ahead: ${status.ahead} commits`);
          if (status.behind > 0) lines.push(`Behind: ${status.behind} commits`);

          if (status.staged.length > 0)
            lines.push(`\nStaged (${status.staged.length}):\n${status.staged.map(f => `  + ${f}`).join('\n')}`);
          if (status.modified.length > 0)
            lines.push(`\nModified (${status.modified.length}):\n${status.modified.map(f => `  M ${f}`).join('\n')}`);
          if (status.not_added.length > 0)
            lines.push(`\nUntracked (${status.not_added.length}):\n${status.not_added.map(f => `  ? ${f}`).join('\n')}`);
          if (status.deleted.length > 0)
            lines.push(`\nDeleted (${status.deleted.length}):\n${status.deleted.map(f => `  - ${f}`).join('\n')}`);
          if (status.conflicted.length > 0)
            lines.push(`\nConflicts (${status.conflicted.length}):\n${status.conflicted.map(f => `  ! ${f}`).join('\n')}`);

          if (status.isClean()) lines.push('\nWorking tree clean.');

          return { success: true, output: lines.join('\n') };
        }

        case 'log': {
          const count = parseInt(args) || 10;
          const log = await git.log({ maxCount: count });
          const lines = log.all.map(c =>
            `${c.hash.substring(0, 7)} ${c.date.substring(0, 10)} ${c.author_name}: ${c.message}`
          );
          return { success: true, output: `Últimos ${lines.length} commits:\n${lines.join('\n')}` };
        }

        case 'diff': {
          const diff = args
            ? await git.diff([args])
            : await git.diff();
          return { success: true, output: diff || '(sin cambios)' };
        }

        case 'add': {
          const files = args ? args.split(/\s+/) : ['.'];
          await git.add(files);
          return { success: true, output: `Agregado al staging: ${files.join(', ')}` };
        }

        case 'commit': {
          if (!args) {
            return { success: false, output: '', error: 'Necesito un mensaje de commit (pasalo en args)' };
          }
          const commitResult = await git.commit(args);
          return {
            success: true,
            output: `Commit: ${commitResult.commit}\nBranch: ${commitResult.branch}\n${commitResult.summary.changes} archivos cambiados, ${commitResult.summary.insertions} inserciones, ${commitResult.summary.deletions} eliminaciones`,
          };
        }

        case 'push': {
          const pushResult = await git.push();
          const info = pushResult.pushed.length > 0
            ? pushResult.pushed.map(p => `${p.local} → ${p.remote}`).join(', ')
            : 'Push completado';
          return { success: true, output: info };
        }

        case 'pull': {
          const pullResult = await git.pull();
          return {
            success: true,
            output: `Pull: ${pullResult.summary.changes} cambios, ${pullResult.summary.insertions} inserciones, ${pullResult.summary.deletions} eliminaciones`,
          };
        }

        case 'branch': {
          if (args) {
            // Create new branch
            await git.branch([args]);
            return { success: true, output: `Branch creada: ${args}` };
          }
          // List branches
          const branches = await git.branch();
          const lines = branches.all.map(b =>
            b === branches.current ? `* ${b} (actual)` : `  ${b}`
          );
          return { success: true, output: `Branches:\n${lines.join('\n')}` };
        }

        case 'checkout': {
          if (!args) {
            return { success: false, output: '', error: 'Necesito el nombre del branch (pasalo en args)' };
          }
          await git.checkout(args);
          return { success: true, output: `Switched to: ${args}` };
        }

        default:
          return { success: false, output: '', error: `Operación no soportada: ${operation}` };
      }
    } catch (err) {
      return {
        success: false,
        output: '',
        error: `Git error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /** Check if a specific operation is dangerous */
  static isDangerous(operation: string): boolean {
    return DANGEROUS_OPS.includes(operation);
  }
}

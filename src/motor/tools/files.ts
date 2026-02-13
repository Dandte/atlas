// ═══════════════════════════════════════
// ATLAS — Unified File Tool (24 actions)
// ATLAS ACTÚA, NO PREGUNTA.
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../types';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import logger from '../../utils/logger';

// ── Helpers ──

/** Expand ~ to the user's home directory */
function expandPath(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

function ok(output: string): ToolResult {
  return { success: true, output };
}

function fail(msg: string): ToolResult {
  return { success: false, output: '', error: msg };
}

function resolvePath(p: string): string {
  return path.resolve(expandPath(p));
}

/** Recursively build a tree representation */
function buildTree(dir: string, prefix: string, depth: number, maxDepth: number, showHidden: boolean): string[] {
  if (depth > maxDepth) return [];
  const lines: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return ['[permission denied]'];
  }

  if (!showHidden) {
    entries = entries.filter(e => !e.name.startsWith('.'));
  }

  // Sort: directories first, then files
  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const isLast = i === entries.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : '│   ';
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      lines.push(`${prefix}${connector}${entry.name}/`);
      if (depth < maxDepth) {
        lines.push(...buildTree(fullPath, prefix + childPrefix, depth + 1, maxDepth, showHidden));
      }
    } else {
      try {
        const stat = fs.statSync(fullPath);
        lines.push(`${prefix}${connector}${entry.name} (${formatSize(stat.size)})`);
      } catch {
        lines.push(`${prefix}${connector}${entry.name}`);
      }
    }
  }
  return lines;
}

/** Recursively copy a directory */
function copyDirRecursive(src: string, dest: string): void {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/** Recursively search for files */
function searchFiles(
  dir: string, namePattern: RegExp | null, contentSearch: string | null,
  results: string[], maxResults: number, depth: number, maxDepth: number
): void {
  if (results.length >= maxResults || depth > maxDepth) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return; }

  for (const entry of entries) {
    if (results.length >= maxResults) break;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'dist', '__pycache__', 'vendor'].includes(entry.name)) continue;
      searchFiles(fullPath, namePattern, contentSearch, results, maxResults, depth + 1, maxDepth);
      continue;
    }

    // Name pattern match
    if (namePattern && !namePattern.test(entry.name)) continue;

    // Content search
    if (contentSearch) {
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > 2 * 1024 * 1024) continue;
        const content = fs.readFileSync(fullPath, 'utf-8');
        if (!content.includes(contentSearch)) continue;
        const lines = content.split('\n');
        const lineNum = lines.findIndex(l => l.includes(contentSearch)) + 1;
        results.push(`${fullPath} (line ${lineNum})`);
        continue;
      } catch { continue; }
    }

    results.push(fullPath);
  }
}

// ═══════════════════════════════════════
// UNIFIED FILE TOOL
// ═══════════════════════════════════════

export class FileTool implements Tool {
  definition = {
    name: 'file',
    description: `Operaciones con archivos y directorios. Acciones: read, create, edit, copy, move, delete, list, tree, search, info, compress, decompress, download, diff, permissions, disk_usage, mkdir, exists, tail, head, count, replace_all, concat, serve. Usar para CUALQUIER operación con archivos en vez de shell.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: [
            'read', 'create', 'edit', 'copy', 'move', 'delete',
            'list', 'tree', 'search', 'info', 'compress', 'decompress',
            'download', 'diff', 'permissions', 'disk_usage', 'mkdir',
            'exists', 'tail', 'head', 'count', 'replace_all', 'concat', 'serve',
          ],
          description: 'Action to perform',
        },
        path: {
          type: 'string',
          description: 'File or directory path',
        },
        content: {
          type: 'string',
          description: 'Content for create/edit (append/prepend)',
        },
        find: {
          type: 'string',
          description: 'Text to find (for edit replace_text, replace_all)',
        },
        replace: {
          type: 'string',
          description: 'Replacement text',
        },
        line: {
          type: 'number',
          description: 'Line number (for edit insert_line)',
        },
        mode: {
          type: 'string',
          enum: ['overwrite', 'append', 'prepend', 'insert_line', 'replace_text'],
          description: 'Edit mode. Default: replace_text for edit, overwrite for create',
        },
        destination: {
          type: 'string',
          description: 'Destination path (copy, move, diff, concat, compress, decompress, download)',
        },
        query: {
          type: 'string',
          description: 'Content search text (for search action)',
        },
        pattern: {
          type: 'string',
          description: 'File name pattern (e.g. *.pdf, *.log) for search',
        },
        recursive: {
          type: 'boolean',
          description: 'Recursive. Default: true',
        },
        format: {
          type: 'string',
          enum: ['zip', 'tar.gz', 'tar'],
          description: 'Compression format. Default: zip',
        },
        depth: {
          type: 'number',
          description: 'Max depth for tree/list. Default: 3',
        },
        show_hidden: {
          type: 'boolean',
          description: 'Show hidden files. Default: false',
        },
        lines: {
          type: 'number',
          description: 'Number of lines for tail/head. Default: 20',
        },
        start_line: {
          type: 'number',
          description: 'Start line (1-based) for read',
        },
        end_line: {
          type: 'number',
          description: 'End line (1-based) for read',
        },
        chmod: {
          type: 'string',
          description: 'Permissions (e.g. 755, 644, +x)',
        },
        owner: {
          type: 'string',
          description: 'Owner (e.g. www-data:www-data)',
        },
        url: {
          type: 'string',
          description: 'Download URL (for download action)',
        },
        files: {
          type: 'array',
          description: 'List of files (for concat action)',
        },
        include_pattern: {
          type: 'string',
          description: 'Filter by file pattern for replace_all (e.g. *.php)',
        },
      },
      required: ['action'],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = params.action as string;

    try {
      switch (action) {

        // ─────── READ ───────
        case 'read': {
          const p = params.path as string;
          if (!p) return fail('Necesito la ruta del archivo');
          const resolved = resolvePath(p);

          if (!fs.existsSync(resolved)) return fail(`Archivo no encontrado: ${resolved}`);
          if (fs.statSync(resolved).isDirectory()) return fail(`Es un directorio, no un archivo: ${resolved}`);

          let content = fs.readFileSync(resolved, 'utf-8');

          const startLine = params.start_line as number | undefined;
          const endLine = params.end_line as number | undefined;
          if (startLine || endLine) {
            const lines = content.split('\n');
            const start = Math.max(1, startLine ?? 1) - 1;
            const end = Math.min(lines.length, endLine ?? lines.length);
            content = lines.slice(start, end)
              .map((line, i) => `${start + i + 1}: ${line}`)
              .join('\n');
          }

          if (content.length > 50000) {
            return ok(
              `Archivo grande (${formatSize(content.length)}). Primeras 500 lineas:\n\n` +
              content.split('\n').slice(0, 500).join('\n') + '\n\n[...truncado...]'
            );
          }
          return ok(content);
        }

        // ─────── CREATE ───────
        case 'create': {
          const p = params.path as string;
          if (!p) return fail('Necesito la ruta del archivo');
          const resolved = resolvePath(p);

          fs.mkdirSync(path.dirname(resolved), { recursive: true });
          fs.writeFileSync(resolved, (params.content as string) || '', 'utf-8');

          const stat = fs.statSync(resolved);
          return ok(`Archivo creado: ${resolved} (${formatSize(stat.size)})`);
        }

        // ─────── EDIT ───────
        case 'edit': {
          const p = params.path as string;
          if (!p) return fail('Necesito la ruta del archivo');
          const resolved = resolvePath(p);
          if (!fs.existsSync(resolved)) return fail(`Archivo no encontrado: ${resolved}`);

          const mode = (params.mode as string) || 'replace_text';

          switch (mode) {
            case 'overwrite': {
              fs.writeFileSync(resolved, (params.content as string) || '', 'utf-8');
              return ok(`Archivo sobrescrito: ${resolved}`);
            }
            case 'append': {
              fs.appendFileSync(resolved, '\n' + ((params.content as string) || ''), 'utf-8');
              return ok(`Contenido agregado al final de ${resolved}`);
            }
            case 'prepend': {
              const current = fs.readFileSync(resolved, 'utf-8');
              fs.writeFileSync(resolved, ((params.content as string) || '') + '\n' + current, 'utf-8');
              return ok(`Contenido agregado al inicio de ${resolved}`);
            }
            case 'insert_line': {
              const lineNum = params.line as number;
              if (!lineNum) return fail('Necesito el numero de linea');
              const lines = fs.readFileSync(resolved, 'utf-8').split('\n');
              lines.splice(lineNum - 1, 0, (params.content as string) || '');
              fs.writeFileSync(resolved, lines.join('\n'), 'utf-8');
              return ok(`Contenido insertado en linea ${lineNum} de ${resolved}`);
            }
            case 'replace_text': {
              const find = params.find as string;
              if (!find) return fail('Necesito el texto a buscar (find)');
              let content = fs.readFileSync(resolved, 'utf-8');
              const count = content.split(find).length - 1;
              if (count === 0) return ok(`No se encontro "${find}" en ${resolved}`);
              content = content.replaceAll(find, (params.replace as string) || '');
              fs.writeFileSync(resolved, content, 'utf-8');
              return ok(`${count} reemplazo(s) en ${resolved}`);
            }
            default:
              return fail(`Modo de edicion no reconocido: ${mode}`);
          }
        }

        // ─────── COPY ───────
        case 'copy': {
          const p = params.path as string;
          const dest = params.destination as string;
          if (!p || !dest) return fail('Necesito path y destination');
          const resolvedSrc = resolvePath(p);
          const resolvedDest = resolvePath(dest);

          if (!fs.existsSync(resolvedSrc)) return fail(`No existe: ${resolvedSrc}`);

          const stat = fs.statSync(resolvedSrc);
          if (stat.isDirectory()) {
            copyDirRecursive(resolvedSrc, resolvedDest);
          } else {
            fs.mkdirSync(path.dirname(resolvedDest), { recursive: true });
            fs.copyFileSync(resolvedSrc, resolvedDest);
          }
          return ok(`Copiado: ${resolvedSrc} -> ${resolvedDest}`);
        }

        // ─────── MOVE / RENAME ───────
        case 'move': {
          const p = params.path as string;
          const dest = params.destination as string;
          if (!p || !dest) return fail('Necesito path y destination');
          const resolvedSrc = resolvePath(p);
          const resolvedDest = resolvePath(dest);

          if (!fs.existsSync(resolvedSrc)) return fail(`No existe: ${resolvedSrc}`);
          fs.mkdirSync(path.dirname(resolvedDest), { recursive: true });
          fs.renameSync(resolvedSrc, resolvedDest);
          return ok(`Movido: ${resolvedSrc} -> ${resolvedDest}`);
        }

        // ─────── DELETE ───────
        case 'delete': {
          const p = params.path as string;
          if (!p) return fail('Necesito la ruta');
          const resolved = resolvePath(p);

          if (!fs.existsSync(resolved)) return fail(`No existe: ${resolved}`);
          fs.rmSync(resolved, { recursive: true, force: true });
          return ok(`Eliminado: ${resolved}`);
        }

        // ─────── LIST ───────
        case 'list': {
          const target = resolvePath((params.path as string) || '.');
          if (!fs.existsSync(target)) return fail(`No existe: ${target}`);
          if (!fs.statSync(target).isDirectory()) return fail(`No es un directorio: ${target}`);

          const showHidden = (params.show_hidden as boolean) ?? false;
          const entries: string[] = [];

          let items = fs.readdirSync(target, { withFileTypes: true });
          if (!showHidden) items = items.filter(e => !e.name.startsWith('.'));

          for (const item of items) {
            const fullPath = path.join(target, item.name);
            if (item.isDirectory()) {
              entries.push(`[DIR]  ${item.name}/`);
            } else {
              try {
                const stat = fs.statSync(fullPath);
                const modified = stat.mtime.toISOString().split('T')[0];
                entries.push(`${formatSize(stat.size).padStart(10)}  ${modified}  ${item.name}`);
              } catch {
                entries.push(`           ${item.name}`);
              }
            }
          }

          return ok(entries.length > 0 ? entries.join('\n') : '(directorio vacio)');
        }

        // ─────── TREE ───────
        case 'tree': {
          const target = resolvePath((params.path as string) || '.');
          if (!fs.existsSync(target)) return fail(`No existe: ${target}`);

          const maxDepth = (params.depth as number) || 3;
          const showHidden = (params.show_hidden as boolean) ?? false;

          const lines = [target + '/'];
          lines.push(...buildTree(target, '', 0, maxDepth, showHidden));

          if (lines.length > 200) {
            return ok(lines.slice(0, 200).join('\n') + '\n\n[...truncado a 200 lineas]');
          }
          return ok(lines.join('\n'));
        }

        // ─────── SEARCH ───────
        case 'search': {
          const target = resolvePath((params.path as string) || '.');
          const contentQuery = params.query as string | undefined;
          const namePattern = params.pattern as string | undefined;

          if (!contentQuery && !namePattern) {
            return fail('Necesito query (buscar en contenido) o pattern (buscar por nombre)');
          }

          let nameRegex: RegExp | null = null;
          if (namePattern) {
            const regexStr = '^' + namePattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
            nameRegex = new RegExp(regexStr, 'i');
          }

          const results: string[] = [];
          const maxResults = 50;
          const maxDepth = (params.recursive as boolean) !== false ? 10 : 1;
          searchFiles(target, nameRegex, contentQuery || null, results, maxResults, 0, maxDepth);

          if (results.length === 0) {
            return ok(contentQuery
              ? `No se encontro "${contentQuery}" en archivos.`
              : `No se encontraron archivos "${namePattern}".`
            );
          }

          const label = contentQuery
            ? `Archivos que contienen "${contentQuery}":`
            : 'Archivos encontrados:';
          return ok(`${label}\n\n${results.join('\n')}${results.length >= maxResults ? '\n... (limite alcanzado)' : ''}`);
        }

        // ─────── INFO ───────
        case 'info': {
          const p = params.path as string;
          if (!p) return fail('Necesito la ruta');
          const resolved = resolvePath(p);
          if (!fs.existsSync(resolved)) return fail(`No existe: ${resolved}`);

          const stat = fs.statSync(resolved);
          const info = [
            `Ruta: ${resolved}`,
            `Tipo: ${stat.isDirectory() ? 'directorio' : 'archivo'}`,
            `Tamano: ${formatSize(stat.size)}`,
            `Permisos: ${(stat.mode & 0o777).toString(8)}`,
            `Creado: ${stat.birthtime.toISOString()}`,
            `Modificado: ${stat.mtime.toISOString()}`,
            `Accedido: ${stat.atime.toISOString()}`,
          ];
          return ok(info.join('\n'));
        }

        // ─────── COMPRESS ───────
        case 'compress': {
          const p = params.path as string;
          if (!p) return fail('Necesito la ruta a comprimir');
          const resolved = resolvePath(p);
          if (!fs.existsSync(resolved)) return fail(`No existe: ${resolved}`);

          const format = (params.format as string) || 'zip';
          const dest = params.destination
            ? resolvePath(params.destination as string)
            : `${resolved}.${format}`;

          const isWin = process.platform === 'win32';

          if (format === 'zip') {
            if (isWin) {
              execSync(
                `powershell -NoProfile -Command "Compress-Archive -Path '${resolved}' -DestinationPath '${dest}' -Force"`,
                { timeout: 120000 }
              );
            } else {
              execSync(`zip -r "${dest}" "${resolved}"`, { timeout: 120000 });
            }
          } else if (format === 'tar.gz') {
            execSync(`tar -czf "${dest}" -C "${path.dirname(resolved)}" "${path.basename(resolved)}"`, { timeout: 120000 });
          } else if (format === 'tar') {
            execSync(`tar -cf "${dest}" -C "${path.dirname(resolved)}" "${path.basename(resolved)}"`, { timeout: 120000 });
          } else {
            return fail(`Formato no soportado: ${format}`);
          }

          const size = fs.statSync(dest).size;
          return ok(`Comprimido: ${dest} (${formatSize(size)})`);
        }

        // ─────── DECOMPRESS ───────
        case 'decompress': {
          const p = params.path as string;
          if (!p) return fail('Necesito el archivo comprimido');
          const resolved = resolvePath(p);
          if (!fs.existsSync(resolved)) return fail(`No existe: ${resolved}`);

          const dest = params.destination
            ? resolvePath(params.destination as string)
            : path.dirname(resolved);

          fs.mkdirSync(dest, { recursive: true });
          const isWin = process.platform === 'win32';

          if (resolved.endsWith('.zip')) {
            if (isWin) {
              execSync(
                `powershell -NoProfile -Command "Expand-Archive -Path '${resolved}' -DestinationPath '${dest}' -Force"`,
                { timeout: 120000 }
              );
            } else {
              execSync(`unzip -o "${resolved}" -d "${dest}"`, { timeout: 120000 });
            }
          } else if (resolved.endsWith('.tar.gz') || resolved.endsWith('.tgz')) {
            execSync(`tar -xzf "${resolved}" -C "${dest}"`, { timeout: 120000 });
          } else if (resolved.endsWith('.tar')) {
            execSync(`tar -xf "${resolved}" -C "${dest}"`, { timeout: 120000 });
          } else if (resolved.endsWith('.7z')) {
            execSync(`7z x "${resolved}" -o"${dest}"`, { timeout: 120000 });
          } else {
            return fail('Formato no reconocido. Soportados: zip, tar.gz, tar, 7z');
          }

          return ok(`Descomprimido en: ${dest}`);
        }

        // ─────── DOWNLOAD ───────
        case 'download': {
          const url = params.url as string;
          if (!url) return fail('Necesito la URL');

          let dest: string;
          if (params.destination) {
            dest = resolvePath(params.destination as string);
          } else if (params.path) {
            dest = resolvePath(params.path as string);
          } else {
            try {
              const urlObj = new URL(url);
              dest = path.resolve(path.basename(urlObj.pathname) || 'download');
            } catch {
              dest = path.resolve('download');
            }
          }

          fs.mkdirSync(path.dirname(dest), { recursive: true });
          const isWin = process.platform === 'win32';

          if (isWin) {
            execSync(
              `powershell -NoProfile -Command "Invoke-WebRequest -Uri '${url}' -OutFile '${dest}'"`,
              { timeout: 120000 }
            );
          } else {
            execSync(`curl -fSL -o "${dest}" "${url}"`, { timeout: 120000 });
          }

          const size = fs.statSync(dest).size;
          return ok(`Descargado: ${dest} (${formatSize(size)})`);
        }

        // ─────── DIFF ───────
        case 'diff': {
          const p = params.path as string;
          const dest = params.destination as string;
          if (!p || !dest) return fail('Necesito dos archivos para comparar');

          const resolvedA = resolvePath(p);
          const resolvedB = resolvePath(dest);
          if (!fs.existsSync(resolvedA)) return fail(`No existe: ${resolvedA}`);
          if (!fs.existsSync(resolvedB)) return fail(`No existe: ${resolvedB}`);

          // Node.js native diff — no external commands needed
          const contentA = fs.readFileSync(resolvedA, 'utf-8');
          const contentB = fs.readFileSync(resolvedB, 'utf-8');

          if (contentA === contentB) return ok('Los archivos son identicos.');

          // Simple line-by-line diff
          const linesA = contentA.split('\n');
          const linesB = contentB.split('\n');
          const diffs: string[] = [];
          const maxLines = Math.max(linesA.length, linesB.length);

          for (let i = 0; i < maxLines && diffs.length < 100; i++) {
            const a = linesA[i];
            const b = linesB[i];
            if (a !== b) {
              if (a !== undefined && b !== undefined) {
                diffs.push(`Linea ${i + 1}:`);
                diffs.push(`  - ${a}`);
                diffs.push(`  + ${b}`);
              } else if (a !== undefined) {
                diffs.push(`Linea ${i + 1}: - ${a}`);
              } else {
                diffs.push(`Linea ${i + 1}: + ${b}`);
              }
            }
          }

          return ok(`Diferencias entre ${path.basename(resolvedA)} y ${path.basename(resolvedB)}:\n\n${diffs.join('\n')}`);
        }

        // ─────── PERMISSIONS ───────
        case 'permissions': {
          const p = params.path as string;
          if (!p) return fail('Necesito la ruta');
          const resolved = resolvePath(p);
          if (!fs.existsSync(resolved)) return fail(`No existe: ${resolved}`);

          if (process.platform === 'win32') {
            return fail('Cambiar permisos con chmod/chown no es soportado en Windows. Usa shell con icacls.');
          }

          const results: string[] = [];
          if (params.chmod) {
            execSync(`chmod ${params.chmod} "${resolved}"`);
            results.push(`Permisos: ${params.chmod}`);
          }
          if (params.owner) {
            execSync(`chown ${params.owner} "${resolved}"`);
            results.push(`Dueno: ${params.owner}`);
          }
          if (results.length === 0) return fail('Necesito chmod o owner');
          return ok(`${resolved}: ${results.join(', ')}`);
        }

        // ─────── DISK USAGE ───────
        case 'disk_usage': {
          const target = resolvePath((params.path as string) || '.');
          const isWin = process.platform === 'win32';

          if (isWin) {
            // Get folder size and disk info via PowerShell
            try {
              const output = execSync(
                `powershell -NoProfile -Command "` +
                `$size = (Get-ChildItem -Path '${target}' -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum; ` +
                `$drive = Get-PSDrive -Name (Split-Path '${target}' -Qualifier).TrimEnd(':'); ` +
                `Write-Output ('Carpeta: ' + [math]::Round($size/1MB, 2) + 'MB'); ` +
                `Write-Output ('Disco usado: ' + [math]::Round($drive.Used/1GB, 1) + 'GB'); ` +
                `Write-Output ('Disco libre: ' + [math]::Round($drive.Free/1GB, 1) + 'GB')"`,
                { encoding: 'utf-8', timeout: 30000 }
              );
              return ok(output.trim());
            } catch (err: any) {
              return ok(`Error obteniendo uso de disco: ${err.message}`);
            }
          } else {
            const output = execSync(
              `du -sh "${target}" && echo "---" && df -h "${target}"`,
              { encoding: 'utf-8', timeout: 30000 }
            );
            return ok(output.trim());
          }
        }

        // ─────── MKDIR ───────
        case 'mkdir': {
          const p = params.path as string;
          if (!p) return fail('Necesito la ruta del directorio');
          const resolved = resolvePath(p);
          fs.mkdirSync(resolved, { recursive: true });
          return ok(`Directorio creado: ${resolved}`);
        }

        // ─────── EXISTS ───────
        case 'exists': {
          const p = params.path as string;
          if (!p) return fail('Necesito la ruta');
          const resolved = resolvePath(p);

          if (fs.existsSync(resolved)) {
            const stat = fs.statSync(resolved);
            return ok(`Si existe: ${stat.isDirectory() ? 'directorio' : 'archivo'} (${formatSize(stat.size)})`);
          }
          return ok(`No existe: ${resolved}`);
        }

        // ─────── TAIL ───────
        case 'tail': {
          const p = params.path as string;
          if (!p) return fail('Necesito la ruta');
          const resolved = resolvePath(p);
          if (!fs.existsSync(resolved)) return fail(`No existe: ${resolved}`);

          const n = (params.lines as number) || 20;
          const content = fs.readFileSync(resolved, 'utf-8');
          const lines = content.split('\n');
          const start = Math.max(0, lines.length - n);

          return ok(lines.slice(start).map((l, i) => `${start + i + 1}: ${l}`).join('\n'));
        }

        // ─────── HEAD ───────
        case 'head': {
          const p = params.path as string;
          if (!p) return fail('Necesito la ruta');
          const resolved = resolvePath(p);
          if (!fs.existsSync(resolved)) return fail(`No existe: ${resolved}`);

          const n = (params.lines as number) || 20;
          const content = fs.readFileSync(resolved, 'utf-8');
          const lines = content.split('\n').slice(0, n);

          return ok(lines.map((l, i) => `${i + 1}: ${l}`).join('\n'));
        }

        // ─────── COUNT ───────
        case 'count': {
          const p = params.path as string;
          if (!p) return fail('Necesito la ruta');
          const resolved = resolvePath(p);
          if (!fs.existsSync(resolved)) return fail(`No existe: ${resolved}`);

          const content = fs.readFileSync(resolved, 'utf-8');
          const lineCount = content.split('\n').length;
          const wordCount = content.split(/\s+/).filter(Boolean).length;
          const charCount = content.length;

          return ok(`Lineas: ${lineCount} | Palabras: ${wordCount} | Caracteres: ${charCount}`);
        }

        // ─────── REPLACE ALL (multi-file) ───────
        case 'replace_all': {
          const find = params.find as string;
          if (!find) return fail('Necesito el texto a buscar');
          const target = resolvePath((params.path as string) || '.');
          const include = params.include_pattern as string | undefined;
          const replaceWith = (params.replace as string) || '';

          let nameRegex: RegExp | null = null;
          if (include) {
            const regexStr = '^' + include.replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
            nameRegex = new RegExp(regexStr, 'i');
          }

          const files: string[] = [];
          searchFiles(target, nameRegex, null, files, 500, 0, 10);

          let totalReplaced = 0;
          let filesChanged = 0;

          for (const file of files) {
            try {
              let content = fs.readFileSync(file, 'utf-8');
              const count = content.split(find).length - 1;
              if (count > 0) {
                content = content.replaceAll(find, replaceWith);
                fs.writeFileSync(file, content, 'utf-8');
                totalReplaced += count;
                filesChanged++;
              }
            } catch { /* skip binary/unreadable files */ }
          }

          return ok(`${totalReplaced} reemplazo(s) en ${filesChanged} archivo(s)`);
        }

        // ─────── CONCAT ───────
        case 'concat': {
          const fileList = params.files as string[];
          const dest = params.destination as string;
          if (!fileList || !dest) return fail('Necesito files[] y destination');

          const resolvedDest = resolvePath(dest);
          fs.mkdirSync(path.dirname(resolvedDest), { recursive: true });

          const contents: string[] = [];
          for (const f of fileList) {
            const resolved = resolvePath(f);
            if (!fs.existsSync(resolved)) return fail(`No existe: ${resolved}`);
            contents.push(fs.readFileSync(resolved, 'utf-8'));
          }

          fs.writeFileSync(resolvedDest, contents.join('\n'), 'utf-8');
          return ok(`${fileList.length} archivos concatenados en ${resolvedDest}`);
        }

        // ─────── SERVE ───────
        case 'serve': {
          const p = params.path as string;
          if (!p) return fail('Necesito la ruta del archivo');
          const resolved = resolvePath(p);
          if (!fs.existsSync(resolved)) return fail(`No existe: ${resolved}`);

          const filename = path.basename(resolved);
          const tempDir = path.join(os.tmpdir(), 'atlas-serve');
          const servePath = path.join(tempDir, `${Date.now()}_${filename}`);

          fs.mkdirSync(tempDir, { recursive: true });
          fs.copyFileSync(resolved, servePath);

          const port = process.env.DASHBOARD_PORT || '4000';
          const url = `http://localhost:${port}/files/${path.basename(servePath)}`;

          // Auto-delete after 1 hour
          setTimeout(() => {
            try { fs.unlinkSync(servePath); } catch { /* ignore */ }
          }, 60 * 60 * 1000);

          return ok(`Link de descarga (valido 1 hora):\n${url}`);
        }

        default:
          return fail(`Accion no reconocida: ${action}. Acciones validas: read, create, edit, copy, move, delete, list, tree, search, info, compress, decompress, download, diff, permissions, disk_usage, mkdir, exists, tail, head, count, replace_all, concat, serve`);
      }
    } catch (err: any) {
      logger.error(`FileTool error (${action})`, { error: err });
      return { success: false, output: '', error: `Error: ${err.message}` };
    }
  }
}

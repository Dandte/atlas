// ═══════════════════════════════════════
// ATLAS — Database Query Tool
// Read-only SQL queries (MySQL)
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../types';
import { config } from '../../config/config';
import logger from '../../utils/logger';
import mysql from 'mysql2/promise';

// Blocked SQL keywords (mutations)
const BLOCKED_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE',
  'CREATE', 'GRANT', 'REVOKE', 'RENAME', 'REPLACE', 'MERGE',
  'CALL', 'EXEC', 'EXECUTE', 'LOAD', 'INTO OUTFILE', 'INTO DUMPFILE',
];

// Allowed SQL keywords (read-only)
const ALLOWED_PREFIXES = ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'];

let pool: mysql.Pool | null = null;

function getPool(): mysql.Pool {
  if (!pool) {
    if (!config.databaseUrl) {
      throw new Error('DATABASE_URL no está configurado en .env');
    }

    const url = new URL(config.databaseUrl);
    pool = mysql.createPool({
      host: url.hostname,
      port: parseInt(url.port) || 3306,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.slice(1),
      waitForConnections: true,
      connectionLimit: 3,
      queueLimit: 0,
      connectTimeout: 10000,
    });
  }
  return pool;
}

export class DatabaseQueryTool implements Tool {
  definition = {
    name: 'database_query',
    description: 'Execute a read-only SQL query. ONLY supports SELECT, SHOW, DESCRIBE, and EXPLAIN. Cannot modify data.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'SQL query (SELECT only)',
        },
        database: {
          type: 'string',
          description: 'Database name (optional, uses the configured default)',
        },
      },
      required: ['query'],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const query = (params.query as string).trim();
    const database = params.database as string | undefined;

    // ── Safety validation ──
    const validation = this.validateQuery(query);
    if (!validation.safe) {
      return { success: false, output: '', error: validation.reason };
    }

    try {
      const dbPool = getPool();
      let connection = await dbPool.getConnection();

      try {
        // Switch database if specified
        if (database) {
          await connection.query(`USE \`${database.replace(/`/g, '')}\``);
        }

        // Execute with timeout
        const [rows] = await connection.query({
          sql: query,
          timeout: 10000,
        });

        const resultRows = rows as Record<string, unknown>[];

        // Handle non-array results (SHOW, DESCRIBE, etc.)
        if (!Array.isArray(resultRows)) {
          return {
            success: true,
            output: JSON.stringify(resultRows, null, 2),
          };
        }

        // Limit rows
        const limited = resultRows.slice(0, 1000);
        const totalRows = resultRows.length;

        if (limited.length === 0) {
          return { success: true, output: '(0 filas)' };
        }

        // Format as table-like output
        const output = this.formatResults(limited, totalRows);
        return { success: true, output };
      } finally {
        connection.release();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: '',
        error: `Error SQL: ${msg}`,
      };
    }
  }

  /** Validate that a query is read-only */
  private validateQuery(query: string): { safe: boolean; reason?: string } {
    const upper = query.toUpperCase().replace(/\s+/g, ' ').trim();

    // Must start with an allowed prefix
    const startsAllowed = ALLOWED_PREFIXES.some(p =>
      upper.startsWith(p + ' ') || upper.startsWith(p + '\t') || upper === p
    );

    if (!startsAllowed) {
      return {
        safe: false,
        reason: `Query no permitida. Solo se aceptan: ${ALLOWED_PREFIXES.join(', ')}`,
      };
    }

    // Check for blocked keywords (could be in subqueries)
    for (const keyword of BLOCKED_KEYWORDS) {
      // Match as whole word to avoid false positives (e.g., "DESCRIPTION" matching "DESC")
      const regex = new RegExp(`\\b${keyword}\\b`, 'i');
      if (regex.test(query)) {
        return {
          safe: false,
          reason: `Query bloqueada: contiene "${keyword}". Solo lectura permitida.`,
        };
      }
    }

    // Block multiple statements (semicolon followed by another statement)
    const semicolonCheck = query.replace(/;[\s]*$/, ''); // Allow trailing semicolon
    if (semicolonCheck.includes(';')) {
      return {
        safe: false,
        reason: 'No se permiten múltiples statements en una query.',
      };
    }

    return { safe: true };
  }

  /** Format query results for display */
  private formatResults(rows: Record<string, unknown>[], totalRows: number): string {
    const lines: string[] = [];

    // Show count
    if (totalRows > 1000) {
      lines.push(`Mostrando 1000 de ${totalRows} filas:\n`);
    } else {
      lines.push(`${totalRows} fila(s):\n`);
    }

    // For small result sets, show as JSON
    if (rows.length <= 20) {
      lines.push(JSON.stringify(rows, null, 2));
    } else {
      // For larger sets, show columnar summary
      const columns = Object.keys(rows[0]);
      lines.push(`Columnas: ${columns.join(', ')}\n`);

      // Show first 5 rows
      for (let i = 0; i < Math.min(5, rows.length); i++) {
        lines.push(JSON.stringify(rows[i]));
      }
      if (rows.length > 5) {
        lines.push(`... (${rows.length - 5} filas más)`);
      }
    }

    const output = lines.join('\n');
    return output.length > 50000 ? output.substring(0, 50000) + '\n... [truncado]' : output;
  }
}

/** Close the connection pool (call on shutdown) */
export async function closeDatabasePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

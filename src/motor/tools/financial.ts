// ═══════════════════════════════════════
// ATLAS — Financial Tracker Tool
// Personal and business expense/income tracking
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import logger from '../../utils/logger';
import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';

export class FinancialTool implements Tool {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initTables();
  }

  definition: ToolDefinition = {
    name: 'financial',
    description: 'Tracker financiero personal y de negocios: registrar ingresos/gastos, ver balances, categorías, reportes mensuales, tendencias.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'balance', 'list', 'summary', 'categories', 'search', 'remove', 'monthly', 'accounts'],
          description: 'add=registrar transacción, balance=ver saldo, list=últimas transacciones, summary=resumen por categoría, categories=ver categorías, search=buscar, remove=eliminar, monthly=reporte mensual, accounts=ver cuentas',
        },
        type: {
          type: 'string',
          enum: ['income', 'expense', 'transfer'],
          description: 'Tipo: income (ingreso), expense (gasto), transfer (transferencia)',
        },
        amount: { type: 'number', description: 'Monto en COP (pesos colombianos)' },
        description: { type: 'string', description: 'Descripción de la transacción' },
        category: { type: 'string', description: 'Categoría (ej: alimentación, transporte, nómina, ventas, servicios)' },
        account: { type: 'string', description: 'Cuenta (ej: personal, negocio, empresa). Default: personal' },
        date: { type: 'string', description: 'Fecha (YYYY-MM-DD). Default: hoy' },
        tags: { type: 'string', description: 'Tags separados por coma' },
        transaction_id: { type: 'string', description: 'ID de transacción (para remove)' },
        month: { type: 'string', description: 'Mes para reporte (YYYY-MM). Default: mes actual' },
        limit: { type: 'number', description: 'Máximo de resultados (default 20)' },
        query: { type: 'string', description: 'Texto a buscar en transacciones' },
      },
      required: ['action'],
    },
  };

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS financial_transactions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('income', 'expense', 'transfer')),
        amount REAL NOT NULL,
        description TEXT,
        category TEXT DEFAULT 'otros',
        account TEXT DEFAULT 'personal',
        tags TEXT DEFAULT '',
        date TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_financial_date ON financial_transactions(date);
      CREATE INDEX IF NOT EXISTS idx_financial_account ON financial_transactions(account);
      CREATE INDEX IF NOT EXISTS idx_financial_category ON financial_transactions(category);
      CREATE INDEX IF NOT EXISTS idx_financial_type ON financial_transactions(type);
    `);
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = String(params.action || '');

    try {
      switch (action) {
        case 'add': return this.addTransaction(params);
        case 'balance': return this.getBalance(params);
        case 'list': return this.listTransactions(params);
        case 'summary': return this.getSummary(params);
        case 'categories': return this.getCategories(params);
        case 'search': return this.searchTransactions(params);
        case 'remove': return this.removeTransaction(params);
        case 'monthly': return this.getMonthlyReport(params);
        case 'accounts': return this.getAccounts();
        default:
          return { success: false, output: '', error: `Acción desconocida: ${action}` };
      }
    } catch (err: any) {
      logger.error('Financial tool error', { action, error: err });
      return { success: false, output: '', error: `Error financiero: ${err.message}` };
    }
  }

  private addTransaction(params: Record<string, unknown>): ToolResult {
    const type = String(params.type || 'expense');
    const amount = Number(params.amount);
    if (!amount || amount <= 0) return { success: false, output: '', error: 'Se requiere amount > 0.' };

    const id = uuid();
    const description = String(params.description || '');
    const category = String(params.category || 'otros').toLowerCase();
    const account = String(params.account || 'personal').toLowerCase();
    const tags = params.tags ? String(params.tags).toLowerCase() : '';
    const date = String(params.date || new Date().toISOString().split('T')[0]);

    this.db.prepare(
      `INSERT INTO financial_transactions (id, type, amount, description, category, account, tags, date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, type, amount, description, category, account, tags, date);

    const emoji = type === 'income' ? '💰' : type === 'expense' ? '💸' : '🔄';
    const sign = type === 'income' ? '+' : type === 'expense' ? '-' : '↔';

    return {
      success: true,
      output: `${emoji} Transacción registrada:\n${sign} $${this.formatMoney(amount)} COP\nDescripción: ${description}\nCategoría: ${category}\nCuenta: ${account}\nFecha: ${date}\nID: ${id.substring(0, 8)}`,
    };
  }

  private getBalance(params: Record<string, unknown>): ToolResult {
    const account = params.account ? String(params.account).toLowerCase() : null;

    let query: string;
    const queryParams: any[] = [];

    if (account) {
      query = `SELECT
        COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) as income,
        COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) as expense
        FROM financial_transactions WHERE account = ?`;
      queryParams.push(account);
    } else {
      query = `SELECT
        COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) as income,
        COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) as expense
        FROM financial_transactions`;
    }

    const row = this.db.prepare(query).get(...queryParams) as any;
    const balance = row.income - row.expense;

    // Also get this month's data
    const monthRow = this.db.prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) as income,
        COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) as expense
       FROM financial_transactions
       WHERE strftime('%Y-%m', date) = strftime('%Y-%m', 'now')
       ${account ? 'AND account = ?' : ''}`
    ).get(...(account ? [account] : [])) as any;

    const monthBalance = monthRow.income - monthRow.expense;

    return {
      success: true,
      output: `💰 Balance${account ? ` (${account})` : ' total'}:
${'─'.repeat(40)}
Ingresos totales: +$${this.formatMoney(row.income)} COP
Gastos totales:   -$${this.formatMoney(row.expense)} COP
Balance neto:     ${balance >= 0 ? '+' : ''}$${this.formatMoney(balance)} COP

📅 Este mes:
Ingresos: +$${this.formatMoney(monthRow.income)} COP
Gastos:   -$${this.formatMoney(monthRow.expense)} COP
Balance:  ${monthBalance >= 0 ? '+' : ''}$${this.formatMoney(monthBalance)} COP`,
    };
  }

  private listTransactions(params: Record<string, unknown>): ToolResult {
    const limit = Number(params.limit) || 20;
    const account = params.account ? String(params.account).toLowerCase() : null;

    let query = 'SELECT id, type, amount, description, category, account, date FROM financial_transactions';
    const queryParams: any[] = [];

    if (account) {
      query += ' WHERE account = ?';
      queryParams.push(account);
    }

    query += ' ORDER BY date DESC, created_at DESC LIMIT ?';
    queryParams.push(limit);

    const rows = this.db.prepare(query).all(...queryParams) as any[];

    if (rows.length === 0) {
      return { success: true, output: 'No hay transacciones registradas.' };
    }

    const formatted = rows.map((r: any) => {
      const emoji = r.type === 'income' ? '💰' : r.type === 'expense' ? '💸' : '🔄';
      const sign = r.type === 'income' ? '+' : '-';
      return `${r.date} ${emoji} ${sign}$${this.formatMoney(r.amount)} | ${r.category} | ${r.description || '(sin desc)'} [${r.account}] ID:${r.id.substring(0, 8)}`;
    });

    return {
      success: true,
      output: `📋 Últimas ${rows.length} transacciones:\n${formatted.join('\n')}`,
    };
  }

  private getSummary(params: Record<string, unknown>): ToolResult {
    const account = params.account ? String(params.account).toLowerCase() : null;
    const month = params.month ? String(params.month) : new Date().toISOString().substring(0, 7);

    let whereClause = "WHERE strftime('%Y-%m', date) = ?";
    const queryParams: any[] = [month];

    if (account) {
      whereClause += ' AND account = ?';
      queryParams.push(account);
    }

    const rows = this.db.prepare(
      `SELECT category, type,
        SUM(amount) as total,
        COUNT(*) as count
       FROM financial_transactions ${whereClause}
       GROUP BY category, type
       ORDER BY total DESC`
    ).all(...queryParams) as any[];

    if (rows.length === 0) {
      return { success: true, output: `No hay transacciones en ${month}.` };
    }

    const incomeCategories = rows.filter(r => r.type === 'income');
    const expenseCategories = rows.filter(r => r.type === 'expense');

    const lines: string[] = [`📊 Resumen ${month}${account ? ` (${account})` : ''}`, '─'.repeat(40)];

    if (incomeCategories.length > 0) {
      lines.push('\n💰 INGRESOS:');
      let totalIncome = 0;
      for (const c of incomeCategories) {
        lines.push(`  ${c.category}: +$${this.formatMoney(c.total)} (${c.count} trans.)`);
        totalIncome += c.total;
      }
      lines.push(`  TOTAL: +$${this.formatMoney(totalIncome)}`);
    }

    if (expenseCategories.length > 0) {
      lines.push('\n💸 GASTOS:');
      let totalExpense = 0;
      for (const c of expenseCategories) {
        lines.push(`  ${c.category}: -$${this.formatMoney(c.total)} (${c.count} trans.)`);
        totalExpense += c.total;
      }
      lines.push(`  TOTAL: -$${this.formatMoney(totalExpense)}`);
    }

    return { success: true, output: lines.join('\n') };
  }

  private getCategories(params: Record<string, unknown>): ToolResult {
    const rows = this.db.prepare(
      `SELECT DISTINCT category, type, COUNT(*) as count
       FROM financial_transactions
       GROUP BY category, type
       ORDER BY count DESC`
    ).all() as any[];

    if (rows.length === 0) {
      return { success: true, output: 'No hay categorías registradas.' };
    }

    const formatted = rows.map(r => {
      const emoji = r.type === 'income' ? '💰' : '💸';
      return `${emoji} ${r.category} (${r.type}) — ${r.count} transacciones`;
    });

    return { success: true, output: `🏷️ Categorías:\n${formatted.join('\n')}` };
  }

  private searchTransactions(params: Record<string, unknown>): ToolResult {
    const query = String(params.query || '');
    if (!query) return { success: false, output: '', error: 'Se requiere query.' };

    const limit = Number(params.limit) || 20;
    const rows = this.db.prepare(
      `SELECT id, type, amount, description, category, account, date
       FROM financial_transactions
       WHERE description LIKE ? OR category LIKE ? OR tags LIKE ?
       ORDER BY date DESC LIMIT ?`
    ).all(`%${query}%`, `%${query}%`, `%${query}%`, limit) as any[];

    if (rows.length === 0) {
      return { success: true, output: `No se encontraron transacciones con: "${query}"` };
    }

    const formatted = rows.map((r: any) => {
      const sign = r.type === 'income' ? '+' : '-';
      return `${r.date} ${sign}$${this.formatMoney(r.amount)} | ${r.category} | ${r.description} [${r.account}]`;
    });

    return { success: true, output: `🔍 "${query}" — ${rows.length} resultados:\n${formatted.join('\n')}` };
  }

  private removeTransaction(params: Record<string, unknown>): ToolResult {
    const id = String(params.transaction_id || '');
    if (!id) return { success: false, output: '', error: 'Se requiere transaction_id.' };

    const result = this.db.prepare('DELETE FROM financial_transactions WHERE id LIKE ?').run(`${id}%`);
    if (result.changes === 0) {
      return { success: false, output: '', error: `Transacción no encontrada: ${id}` };
    }

    return { success: true, output: 'Transacción eliminada.' };
  }

  private getMonthlyReport(params: Record<string, unknown>): ToolResult {
    const month = params.month ? String(params.month) : new Date().toISOString().substring(0, 7);

    // Get daily totals for the month
    const dailyRows = this.db.prepare(
      `SELECT date,
        SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as income,
        SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) as expense
       FROM financial_transactions
       WHERE strftime('%Y-%m', date) = ?
       GROUP BY date ORDER BY date ASC`
    ).all(month) as any[];

    // Get account breakdown
    const accountRows = this.db.prepare(
      `SELECT account,
        SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as income,
        SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) as expense,
        COUNT(*) as count
       FROM financial_transactions
       WHERE strftime('%Y-%m', date) = ?
       GROUP BY account ORDER BY income DESC`
    ).all(month) as any[];

    // Get top expenses
    const topExpenses = this.db.prepare(
      `SELECT description, amount, category, date
       FROM financial_transactions
       WHERE strftime('%Y-%m', date) = ? AND type = 'expense'
       ORDER BY amount DESC LIMIT 5`
    ).all(month) as any[];

    const lines: string[] = [`📈 Reporte mensual: ${month}`, '═'.repeat(40)];

    if (accountRows.length === 0) {
      return { success: true, output: `No hay datos para ${month}.` };
    }

    // Account breakdown
    lines.push('\n📊 Por cuenta:');
    let totalIncome = 0, totalExpense = 0;
    for (const a of accountRows) {
      const balance = a.income - a.expense;
      lines.push(`  ${a.account}: +$${this.formatMoney(a.income)} / -$${this.formatMoney(a.expense)} = ${balance >= 0 ? '+' : ''}$${this.formatMoney(balance)} (${a.count} trans.)`);
      totalIncome += a.income;
      totalExpense += a.expense;
    }
    const totalBalance = totalIncome - totalExpense;
    lines.push(`\n  TOTAL: +$${this.formatMoney(totalIncome)} / -$${this.formatMoney(totalExpense)} = ${totalBalance >= 0 ? '+' : ''}$${this.formatMoney(totalBalance)}`);

    // Top expenses
    if (topExpenses.length > 0) {
      lines.push('\n💸 Top 5 gastos:');
      for (const e of topExpenses) {
        lines.push(`  $${this.formatMoney(e.amount)} — ${e.description || e.category} (${e.date})`);
      }
    }

    // Daily activity (simplified)
    if (dailyRows.length > 0) {
      lines.push(`\n📅 Días con actividad: ${dailyRows.length}`);
      const avgDaily = totalExpense / dailyRows.length;
      lines.push(`Gasto diario promedio: $${this.formatMoney(avgDaily)}`);
    }

    return { success: true, output: lines.join('\n') };
  }

  private getAccounts(): ToolResult {
    const rows = this.db.prepare(
      `SELECT account,
        SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as income,
        SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) as expense,
        COUNT(*) as count,
        MAX(date) as last_activity
       FROM financial_transactions
       GROUP BY account ORDER BY count DESC`
    ).all() as any[];

    if (rows.length === 0) {
      return { success: true, output: 'No hay cuentas registradas.' };
    }

    const formatted = rows.map((r: any) => {
      const balance = r.income - r.expense;
      return `${r.account}: ${balance >= 0 ? '+' : ''}$${this.formatMoney(balance)} COP (${r.count} trans., última: ${r.last_activity})`;
    });

    return { success: true, output: `🏦 Cuentas:\n${formatted.join('\n')}` };
  }

  private formatMoney(amount: number): string {
    return Math.abs(amount).toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }
}

// ═══════════════════════════════════════
// ATLAS — Plugin Manager
// v0.9 Feature 5: Plugin Marketplace
// ═══════════════════════════════════════

import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import path from 'path';
import fs from 'fs';
import { Tool, PluginInfo } from '../types';
import { ToolRegistry } from '../motor/tool-registry';
import { config } from '../config/config';
import logger from '../utils/logger';

interface PluginModule {
  name: string;
  version: string;
  description?: string;
  author?: string;
  tools: Tool[];
  init?: (pluginConfig: Record<string, any>) => Promise<void>;
  destroy?: () => Promise<void>;
}

export class PluginManager {
  private db: Database.Database;
  private registry: ToolRegistry;
  private loaded: Map<string, { module: PluginModule; tools: string[] }> = new Map();

  constructor(db: Database.Database, registry: ToolRegistry) {
    this.db = db;
    this.registry = registry;
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plugins (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        version TEXT NOT NULL,
        description TEXT,
        author TEXT,
        source TEXT NOT NULL,
        source_path TEXT NOT NULL,
        tools_provided TEXT DEFAULT '[]',
        installed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        enabled INTEGER DEFAULT 1,
        config TEXT DEFAULT '{}'
      )
    `);

    // Ensure plugins directory exists
    const pluginsDir = config.pluginsDir;
    if (!fs.existsSync(pluginsDir)) {
      fs.mkdirSync(pluginsDir, { recursive: true });
    }

    logger.info('PluginManager initialized');
  }

  /** Load all installed and enabled plugins */
  async loadInstalled(): Promise<number> {
    const plugins = this.db.prepare(
      'SELECT * FROM plugins WHERE enabled = 1'
    ).all() as any[];

    let loaded = 0;
    for (const plugin of plugins) {
      try {
        await this.loadPlugin(plugin.name, plugin.source, plugin.source_path, JSON.parse(plugin.config || '{}'));
        loaded++;
      } catch (err) {
        logger.error(`Failed to load plugin "${plugin.name}"`, { error: err });
      }
    }

    logger.info(`${loaded}/${plugins.length} plugins loaded`);
    return loaded;
  }

  /** Install a new plugin from local path */
  async install(source: 'local', sourcePath: string): Promise<{ name: string; tools: string[] }> {
    const fullPath = path.isAbsolute(sourcePath)
      ? sourcePath
      : path.join(config.pluginsDir, sourcePath);

    if (!fs.existsSync(fullPath)) {
      throw new Error(`Plugin file not found: ${fullPath}`);
    }

    // Load the module
    const pluginModule = this.loadModule(fullPath);
    this.validateModule(pluginModule);

    // Check if already installed
    const existing = this.db.prepare('SELECT id FROM plugins WHERE name = ?').get(pluginModule.name) as any;
    if (existing) {
      throw new Error(`Plugin "${pluginModule.name}" already installed`);
    }

    // Register tools
    const toolNames: string[] = [];
    for (const tool of pluginModule.tools) {
      this.registry.register(tool);
      toolNames.push(tool.definition.name);
    }

    // Call init if available
    if (pluginModule.init) {
      await pluginModule.init({});
    }

    // Save to DB
    const id = uuid();
    this.db.prepare(`
      INSERT INTO plugins (id, name, version, description, author, source, source_path, tools_provided)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, pluginModule.name, pluginModule.version, pluginModule.description || '',
           pluginModule.author || '', source, sourcePath, JSON.stringify(toolNames));

    this.loaded.set(pluginModule.name, { module: pluginModule, tools: toolNames });

    logger.info(`Plugin installed: "${pluginModule.name}" v${pluginModule.version} (${toolNames.length} tools)`);
    return { name: pluginModule.name, tools: toolNames };
  }

  /** Uninstall a plugin */
  async uninstall(name: string): Promise<boolean> {
    const plugin = this.loaded.get(name);
    if (plugin) {
      // Call destroy if available
      if (plugin.module.destroy) {
        try { await plugin.module.destroy(); } catch { /* ignore */ }
      }
      // Unregister tools
      for (const toolName of plugin.tools) {
        this.registry.unregister(toolName);
      }
      this.loaded.delete(name);
    }

    const result = this.db.prepare('DELETE FROM plugins WHERE name = ?').run(name);
    if (result.changes > 0) {
      logger.info(`Plugin uninstalled: "${name}"`);
    }
    return result.changes > 0;
  }

  /** Enable/disable a plugin */
  async togglePlugin(name: string, enabled: boolean): Promise<void> {
    this.db.prepare('UPDATE plugins SET enabled = ? WHERE name = ?').run(enabled ? 1 : 0, name);

    if (enabled && !this.loaded.has(name)) {
      const row = this.db.prepare('SELECT * FROM plugins WHERE name = ?').get(name) as any;
      if (row) {
        await this.loadPlugin(name, row.source, row.source_path, JSON.parse(row.config || '{}'));
      }
    } else if (!enabled && this.loaded.has(name)) {
      const plugin = this.loaded.get(name)!;
      for (const toolName of plugin.tools) {
        this.registry.unregister(toolName);
      }
      if (plugin.module.destroy) {
        try { await plugin.module.destroy(); } catch { /* ignore */ }
      }
      this.loaded.delete(name);
    }
  }

  /** List all plugins (installed) */
  listPlugins(): PluginInfo[] {
    const rows = this.db.prepare('SELECT * FROM plugins ORDER BY installed_at DESC').all() as any[];
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      version: r.version,
      description: r.description || '',
      author: r.author || '',
      source: r.source,
      toolsProvided: JSON.parse(r.tools_provided || '[]'),
      enabled: r.enabled === 1,
      installedAt: r.installed_at,
    }));
  }

  /** Get loaded plugin count */
  getLoadedCount(): number {
    return this.loaded.size;
  }

  /** List available (not yet installed) plugins from the plugins directory */
  listAvailable(): Array<{ file: string; name: string; version: string; description: string; author: string; tools: string[] }> {
    const pluginsDir = config.pluginsDir;
    if (!fs.existsSync(pluginsDir)) return [];

    const installed = new Set(this.listPlugins().map(p => p.name));
    const available: Array<{ file: string; name: string; version: string; description: string; author: string; tools: string[] }> = [];

    const files = fs.readdirSync(pluginsDir).filter(f => f.endsWith('.ts') || f.endsWith('.js'));

    for (const file of files) {
      try {
        const fullPath = path.join(pluginsDir, file);
        const content = fs.readFileSync(fullPath, 'utf-8');

        // Extract metadata via regex (without requiring/executing the file)
        const nameMatch = content.match(/export\s+const\s+name\s*=\s*['"`]([^'"`]+)['"`]/);
        const versionMatch = content.match(/export\s+const\s+version\s*=\s*['"`]([^'"`]+)['"`]/);
        const descMatch = content.match(/export\s+const\s+description\s*=\s*['"`]([^'"`]+)['"`]/);
        const authorMatch = content.match(/export\s+const\s+author\s*=\s*['"`]([^'"`]+)['"`]/);

        // Extract tool names from definition blocks
        const toolNames: string[] = [];
        const toolMatches = content.matchAll(/name:\s*['"`]([a-z_]+)['"`],\s*\n?\s*description:/g);
        for (const m of toolMatches) {
          toolNames.push(m[1]);
        }

        const pluginName = nameMatch?.[1] || file.replace(/\.(ts|js)$/, '');

        if (installed.has(pluginName)) continue; // Already installed

        available.push({
          file,
          name: pluginName,
          version: versionMatch?.[1] || '1.0.0',
          description: descMatch?.[1] || '',
          author: authorMatch?.[1] || '',
          tools: toolNames,
        });
      } catch (err) {
        logger.debug(`Could not read plugin metadata from ${file}`, { error: err });
      }
    }

    return available;
  }

  private async loadPlugin(name: string, source: string, sourcePath: string, pluginConfig: Record<string, any>): Promise<void> {
    const fullPath = source === 'local'
      ? (path.isAbsolute(sourcePath) ? sourcePath : path.join(config.pluginsDir, sourcePath))
      : sourcePath;

    const pluginModule = this.loadModule(fullPath);
    this.validateModule(pluginModule);

    // Register tools
    const toolNames: string[] = [];
    for (const tool of pluginModule.tools) {
      this.registry.register(tool);
      toolNames.push(tool.definition.name);
    }

    if (pluginModule.init) {
      await pluginModule.init(pluginConfig);
    }

    this.loaded.set(name, { module: pluginModule, tools: toolNames });
  }

  private loadModule(fullPath: string): PluginModule {
    // Clear require cache for hot-reload
    delete require.cache[require.resolve(fullPath)];
    return require(fullPath) as PluginModule;
  }

  private validateModule(mod: PluginModule): void {
    if (!mod.name) throw new Error('Plugin must export "name"');
    if (!mod.version) throw new Error('Plugin must export "version"');
    if (!Array.isArray(mod.tools)) throw new Error('Plugin must export "tools" array');
    for (const tool of mod.tools) {
      if (!tool.definition?.name || !tool.execute) {
        throw new Error(`Invalid tool in plugin: missing definition or execute`);
      }
    }
  }
}

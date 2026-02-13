// ═══════════════════════════════════════
// ATLAS — Personality Profiles
// v0.9 Feature 11: Switchable personality profiles
// ═══════════════════════════════════════

import Database from 'better-sqlite3';
import { PersonalityProfile } from '../types';
import logger from '../utils/logger';

const DEFAULT_PROFILES: Array<Omit<PersonalityProfile, 'active'> & { active: boolean }> = [
  {
    id: 'profesional',
    name: 'profesional',
    displayName: 'Profesional',
    temperature: 0.5,
    toneInstructions: 'Tono formal pero amigable. Sin emojis. Respuestas estructuradas y concisas. Usa usted en vez de vos. Prioriza claridad y precisión.',
    emojiLevel: 'none',
    formality: 'formal',
    active: false,
  },
  {
    id: 'casual',
    name: 'casual',
    displayName: 'Casual',
    temperature: 0.8,
    toneInstructions: 'Tono relajado, natural. Usa vos y jerga colombiana cuando sea apropiado (parcero, bacano, etc). Respuestas fluidas como en una conversación entre amigos.',
    emojiLevel: 'moderate',
    formality: 'casual',
    active: true,
  },
  {
    id: 'tecnico',
    name: 'tecnico',
    displayName: 'Tecnico',
    temperature: 0.3,
    toneInstructions: 'Respuestas tecnicas, precisas, con codigo y comandos cuando aplique. Evita rodeos. Usa terminologia exacta. Incluye snippets de codigo cuando sea util.',
    emojiLevel: 'none',
    formality: 'technical',
    active: false,
  },
  {
    id: 'creativo',
    name: 'creativo',
    displayName: 'Creativo',
    temperature: 0.9,
    toneInstructions: 'Respuestas creativas, usa analogias y metaforas. Estilo narrativo cuando aplique. Piensa fuera de la caja. Sugiere ideas originales e inesperadas.',
    emojiLevel: 'heavy',
    formality: 'creative',
    active: false,
  },
];

export class ProfileManager {
  private db: Database.Database;
  private profiles: Map<string, PersonalityProfile> = new Map();

  constructor(db: Database.Database) {
    this.db = db;
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS personality_profiles (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL,
        temperature REAL DEFAULT 0.7,
        tone_instructions TEXT NOT NULL,
        emoji_level TEXT DEFAULT 'moderate',
        formality TEXT DEFAULT 'casual',
        active INTEGER DEFAULT 0,
        auto_switch_rules TEXT
      )
    `);

    // Seed defaults if table is empty
    const count = (this.db.prepare('SELECT COUNT(*) as c FROM personality_profiles').get() as any).c;
    if (count === 0) {
      const insert = this.db.prepare(`
        INSERT INTO personality_profiles (id, name, display_name, temperature, tone_instructions, emoji_level, formality, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const p of DEFAULT_PROFILES) {
        insert.run(p.id, p.name, p.displayName, p.temperature, p.toneInstructions, p.emojiLevel, p.formality, p.active ? 1 : 0);
      }
      logger.info('Personality profiles seeded with defaults');
    }

    this.loadProfiles();
  }

  private loadProfiles(): void {
    const rows = this.db.prepare('SELECT * FROM personality_profiles').all() as any[];
    this.profiles.clear();
    for (const r of rows) {
      this.profiles.set(r.id, {
        id: r.id,
        name: r.name,
        displayName: r.display_name,
        temperature: r.temperature,
        toneInstructions: r.tone_instructions,
        emojiLevel: r.emoji_level,
        formality: r.formality,
        active: r.active === 1,
        autoSwitchRules: r.auto_switch_rules ? JSON.parse(r.auto_switch_rules) : undefined,
      });
    }
  }

  getActiveProfile(context?: { channel?: string; hour?: number }): PersonalityProfile | null {
    // Check auto-switch rules first
    if (context) {
      for (const profile of this.profiles.values()) {
        if (!profile.autoSwitchRules) continue;
        const rules = profile.autoSwitchRules;
        if (rules.channel && rules.channel === context.channel) return profile;
        if (rules.timeRange && context.hour !== undefined) {
          const [start, end] = (rules.timeRange as string).split('-').map(Number);
          if (context.hour >= start && context.hour < end) return profile;
        }
      }
    }

    // Return manually active profile
    for (const profile of this.profiles.values()) {
      if (profile.active) return profile;
    }
    return null;
  }

  setActiveProfile(profileId: string): boolean {
    if (!this.profiles.has(profileId)) return false;
    // Deactivate all
    this.db.prepare('UPDATE personality_profiles SET active = 0').run();
    // Activate selected
    this.db.prepare('UPDATE personality_profiles SET active = 1 WHERE id = ?').run(profileId);
    this.loadProfiles();
    logger.info(`Personality profile activated: ${profileId}`);
    return true;
  }

  getProfiles(): PersonalityProfile[] {
    return Array.from(this.profiles.values());
  }

  getProfile(id: string): PersonalityProfile | null {
    return this.profiles.get(id) || null;
  }

  updateProfile(id: string, updates: Partial<PersonalityProfile>): boolean {
    if (!this.profiles.has(id)) return false;
    const sets: string[] = [];
    const values: any[] = [];

    if (updates.displayName !== undefined) { sets.push('display_name = ?'); values.push(updates.displayName); }
    if (updates.temperature !== undefined) { sets.push('temperature = ?'); values.push(updates.temperature); }
    if (updates.toneInstructions !== undefined) { sets.push('tone_instructions = ?'); values.push(updates.toneInstructions); }
    if (updates.emojiLevel !== undefined) { sets.push('emoji_level = ?'); values.push(updates.emojiLevel); }
    if (updates.formality !== undefined) { sets.push('formality = ?'); values.push(updates.formality); }
    if (updates.autoSwitchRules !== undefined) { sets.push('auto_switch_rules = ?'); values.push(JSON.stringify(updates.autoSwitchRules)); }

    if (sets.length === 0) return false;
    values.push(id);
    this.db.prepare(`UPDATE personality_profiles SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    this.loadProfiles();
    return true;
  }

  addProfile(profile: Omit<PersonalityProfile, 'active'>): string {
    this.db.prepare(`
      INSERT INTO personality_profiles (id, name, display_name, temperature, tone_instructions, emoji_level, formality, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `).run(profile.id, profile.name, profile.displayName, profile.temperature, profile.toneInstructions, profile.emojiLevel, profile.formality);
    this.loadProfiles();
    return profile.id;
  }

  deleteProfile(id: string): boolean {
    // Don't delete default profiles
    if (['profesional', 'casual', 'tecnico', 'creativo'].includes(id)) return false;
    const result = this.db.prepare('DELETE FROM personality_profiles WHERE id = ?').run(id);
    this.loadProfiles();
    return result.changes > 0;
  }
}

// ═══════════════════════════════════════
// ATLAS — Working Memory (Phase 4)
// Builds intelligent context per request
// ═══════════════════════════════════════

import { EpisodicMemory } from './episodic';
import { SemanticMemory } from './semantic';
import { IVectorStore } from './vector-store';
import { Message, WorkingMemoryContext } from '../types';
import { config } from '../config/config';
import logger from '../utils/logger';

/** Extended context with document chunks and behavioral insights */
export interface ExtendedWorkingMemoryContext extends WorkingMemoryContext {
  documentChunks: Array<{ text: string; filename: string }>;
  behaviorInsights: string;
}

export class WorkingMemory {
  private episodic: EpisodicMemory;
  private semantic: SemanticMemory;
  private vectorStore: IVectorStore | null;
  private behaviorEngine: any = null;

  constructor(
    episodic: EpisodicMemory,
    semantic: SemanticMemory,
    vectorStore: IVectorStore | null = null
  ) {
    this.episodic = episodic;
    this.semantic = semantic;
    this.vectorStore = vectorStore;
  }

  /** Set BehaviorEngine for proactive insights injection */
  setBehaviorEngine(engine: any): void {
    this.behaviorEngine = engine;
  }

  /** Update vector store reference (set after async init) */
  setVectorStore(store: IVectorStore | null): void {
    this.vectorStore = store;
  }

  /** Build conversation history for the current session as Message[] */
  buildConversationHistory(sessionId: string): Message[] {
    const episodes = this.episodic.getSessionHistory(
      sessionId,
      config.maxContextMessages
    );
    const messages: Message[] = [];

    for (const ep of episodes) {
      if (ep.role === 'user' || ep.role === 'assistant') {
        messages.push({
          role: ep.role as 'user' | 'assistant',
          content: ep.content,
        });
      }
    }

    return messages;
  }

  /**
   * Build full WorkingMemoryContext for a request.
   * Gathers temporal info, relevant facts, similar episodes, user profile.
   * Includes thread memory for conversation continuity detection.
   */
  async buildContext(
    sessionId: string,
    userMessage: string
  ): Promise<ExtendedWorkingMemoryContext> {
    // 1. TEMPORAL
    const temporal = this.getTemporal();

    // 2. RELEVANT FACTS (semantic search if available, else keyword)
    const relevantFacts = await this.gatherRelevantFacts(userMessage);

    // 3. SIMILAR EPISODES (vector search on past interactions)
    const similarEpisodes = await this.findSimilarEpisodes(userMessage);

    // 4. THREAD MEMORY — detect references to past conversations
    const threadContext = await this.detectThreadContinuity(userMessage);
    if (threadContext.length > 0) {
      // Merge thread episodes into similar episodes with high relevance
      for (const ep of threadContext) {
        if (!similarEpisodes.find(e => e.summary === ep.summary)) {
          similarEpisodes.unshift(ep);
        }
      }
      // Keep top 5 episodes
      while (similarEpisodes.length > 5) similarEpisodes.pop();
    }

    // 5. USER PROFILE
    const userProfile = this.buildUserProfile();

    // 6. RECENT MESSAGES COUNT
    const recentMessages = this.episodic.getSessionHistory(sessionId).length;

    // 7. DOCUMENT CHUNKS (RAG — if enabled and vector store available)
    const documentChunks = await this.findRelevantDocumentChunks(userMessage);

    // 8. BEHAVIORAL INSIGHTS (proactive intelligence)
    let behaviorInsights = '';
    if (this.behaviorEngine) {
      try {
        behaviorInsights = this.behaviorEngine.getInsightsForPrompt();
      } catch { /* non-critical */ }
    }

    return {
      temporal,
      relevantFacts,
      similarEpisodes,
      userProfile,
      recentMessages,
      activeGoals: [],
      documentChunks,
      behaviorInsights,
    };
  }

  /** Get temporal context */
  private getTemporal(): WorkingMemoryContext['temporal'] {
    const now = new Date();
    const hourStr = now.toLocaleString('en-US', {
      timeZone: 'America/Bogota',
      hour: 'numeric',
      hour12: false,
    });
    const hour = parseInt(hourStr, 10) || 0;

    return {
      datetime: now.toLocaleString('es-CO', {
        timeZone: 'America/Bogota',
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      }),
      dayOfWeek: now.toLocaleDateString('es-CO', {
        weekday: 'long',
        timeZone: 'America/Bogota',
      }),
      timeOfDay:
        hour < 6
          ? 'madrugada'
          : hour < 12
            ? 'mañana'
            : hour < 18
              ? 'tarde'
              : 'noche',
      isWeekend: [0, 6].includes(now.getDay()),
    };
  }

  /** Gather relevant facts — uses vector store if available, else keyword search */
  private async gatherRelevantFacts(
    userMessage: string
  ): Promise<Array<{ key: string; value: string }>> {
    const relevantFacts: Array<{ key: string; value: string }> = [];
    const seen = new Set<string>();

    // Semantic search via vector store
    if (this.vectorStore) {
      try {
        const results = await this.vectorStore.search(userMessage, 10);
        for (const r of results) {
          const key = r.metadata?.key || 'context';
          if (!seen.has(key)) {
            seen.add(key);
            relevantFacts.push({ key, value: r.text });
          }
        }
      } catch (err) {
        logger.debug('Vector search failed, falling back to keyword', {
          error: err,
        });
      }
    }

    // Keyword search fallback / supplement
    if (relevantFacts.length < 10) {
      const words = userMessage
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3);
      for (const word of words) {
        const matches = this.semantic.search(word, 5);
        for (const fact of matches) {
          if (!seen.has(fact.key)) {
            seen.add(fact.key);
            relevantFacts.push({ key: fact.key, value: fact.value });
          }
        }
        if (relevantFacts.length >= 10) break;
      }
    }

    // Fill with most referenced facts if still sparse
    if (relevantFacts.length < 5) {
      const topFacts = this.semantic.getMostReferenced(10);
      for (const fact of topFacts) {
        if (!seen.has(fact.key)) {
          seen.add(fact.key);
          relevantFacts.push({ key: fact.key, value: fact.value });
        }
        if (relevantFacts.length >= 10) break;
      }
    }

    return relevantFacts.slice(0, 15);
  }

  /** Find similar past episodes via vector store */
  private async findSimilarEpisodes(
    userMessage: string
  ): Promise<
    Array<{ summary: string; date: string; relevanceScore: number }>
  > {
    if (!this.vectorStore) return [];

    try {
      const results = await this.vectorStore.search(userMessage, 3);
      return results
        .filter((r) => r.metadata?.type === 'episode_summary')
        .map((r) => ({
          summary: r.text,
          date: r.metadata?.timestamp || '',
          relevanceScore: 1 - r.distance,
        }));
    } catch {
      return [];
    }
  }

  /** Find relevant document chunks (RAG) via vector store filtered search */
  private async findRelevantDocumentChunks(
    userMessage: string
  ): Promise<Array<{ text: string; filename: string }>> {
    if (!this.vectorStore || !config.ragEnabled) return [];

    try {
      const results = await this.vectorStore.searchWithFilter(
        userMessage,
        3,
        (meta) => meta.type === 'document_chunk'
      );
      return results
        .filter(r => r.distance < 0.7) // Only include reasonably relevant chunks
        .map(r => ({
          text: r.text,
          filename: r.metadata?.filename || 'unknown',
        }));
    } catch {
      return [];
    }
  }

  /**
   * Thread Memory: detect when user references past conversations.
   * Patterns: "seguimos con...", "lo del servidor", "como dijiste", "hablamos de...", etc.
   */
  private async detectThreadContinuity(
    userMessage: string
  ): Promise<Array<{ summary: string; date: string; relevanceScore: number }>> {
    const threadPatterns = [
      /seguimos?\s+(con|en)\s+(.+)/i,
      /continuamos?\s+(con|en)\s+(.+)/i,
      /lo\s+(del?|que)\s+(.+)/i,
      /como\s+(te\s+)?dij[eo]\s+(.+)/i,
      /hablamos\s+(de|sobre)\s+(.+)/i,
      /mencion[éeao]\s+(.+)/i,
      /recuerd[ao]s?\s+(que|lo|cuando)\s+(.+)/i,
      /ayer\s+(te|me)\s+(.+)/i,
      /la\s+vez\s+pasada\s+(.+)/i,
      /antes\s+(te|me)\s+(dij|ped|preg)\w+\s+(.+)/i,
    ];

    let topicHint = '';
    for (const pattern of threadPatterns) {
      const match = userMessage.match(pattern);
      if (match) {
        // Get the last capture group (most specific)
        topicHint = match[match.length - 1]?.trim() || '';
        break;
      }
    }

    if (!topicHint || topicHint.length < 3) return [];

    // Search for related episodes using vector store
    if (this.vectorStore) {
      try {
        const results = await this.vectorStore.search(topicHint, 5);
        return results
          .filter(r => r.metadata?.type === 'episode_summary' && r.distance < 0.6)
          .map(r => ({
            summary: r.text,
            date: r.metadata?.timestamp || '',
            relevanceScore: 1 - r.distance,
          }));
      } catch {
        // fallthrough to keyword search
      }
    }

    // Keyword fallback: search recent episodes
    const recentEps = this.episodic.getRecent(100);
    const keywords = topicHint.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const matches = recentEps
      .filter(ep => {
        const content = ep.content.toLowerCase();
        return keywords.some(kw => content.includes(kw));
      })
      .slice(0, 3)
      .map(ep => ({
        summary: `[${ep.role}] ${ep.content.substring(0, 300)}`,
        date: ep.timestamp || '',
        relevanceScore: 0.7,
      }));

    return matches;
  }

  /** Build compact user profile from all facts */
  private buildUserProfile(): string {
    const facts = this.semantic.getAll(100);
    if (facts.length === 0)
      return 'No hay información guardada sobre el usuario aún.';

    const personal = facts.filter((f) =>
      f.key.match(/nombre|edad|ubicación|idioma|país|ciudad/i)
    );
    const professional = facts.filter((f) =>
      f.key.match(/empresa|trabajo|rol|tecnolog|lenguaje_prog|negocio|tienda/i)
    );
    const preferences = facts.filter((f) =>
      f.key.match(/prefer|estilo|gusta|favorit|formato/i)
    );
    const categorized = new Set([
      ...personal,
      ...professional,
      ...preferences,
    ]);
    const other = facts.filter((f) => !categorized.has(f));

    const sections: string[] = [];
    if (personal.length)
      sections.push(
        'Personal: ' + personal.map((f) => `${f.key}: ${f.value}`).join(', ')
      );
    if (professional.length)
      sections.push(
        'Profesional: ' +
          professional.map((f) => `${f.key}: ${f.value}`).join(', ')
      );
    if (preferences.length)
      sections.push(
        'Preferencias: ' +
          preferences.map((f) => `${f.key}: ${f.value}`).join(', ')
      );
    if (other.length && other.length <= 10)
      sections.push(
        'Otros: ' + other.map((f) => `${f.key}: ${f.value}`).join(', ')
      );

    return sections.join('\n');
  }

  /** Format WorkingMemoryContext for injection into system prompt */
  formatForSystemPrompt(context: ExtendedWorkingMemoryContext): string {
    const parts: string[] = [];

    parts.push(`## Contexto actual`);
    parts.push(
      `Fecha: ${context.temporal.datetime} (${context.temporal.dayOfWeek}, ${context.temporal.timeOfDay})`
    );
    if (context.temporal.isWeekend) parts.push('(Fin de semana)');

    if (
      context.userProfile &&
      context.userProfile !== 'No hay información guardada sobre el usuario aún.'
    ) {
      parts.push(`\n## Lo que sé sobre el usuario`);
      parts.push(context.userProfile);
    }

    if (context.relevantFacts.length > 0) {
      parts.push(`\n## Hechos relevantes a esta conversación`);
      parts.push(
        context.relevantFacts.map((f) => `- ${f.key}: ${f.value}`).join('\n')
      );
    }

    if (context.similarEpisodes.length > 0) {
      parts.push(`\n## Interacciones similares pasadas`);
      parts.push(
        context.similarEpisodes
          .map((e) => `- [${e.date}] ${e.summary}`)
          .join('\n')
      );
    }

    if (context.documentChunks && context.documentChunks.length > 0) {
      parts.push(`\n## Información relevante de documentos`);
      parts.push(
        context.documentChunks
          .map((c) => `[${c.filename}]: ${c.text.substring(0, 500)}`)
          .join('\n\n')
      );
    }

    if (context.behaviorInsights) {
      parts.push(`\n${context.behaviorInsights}`);
    }

    return parts.join('\n');
  }
}

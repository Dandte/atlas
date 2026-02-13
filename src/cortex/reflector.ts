// ═══════════════════════════════════════
// ATLAS — Reflector
// Post-interaction analysis & learning
// Extracts facts, evaluates quality,
// detects patterns, identifies skill gaps
// ═══════════════════════════════════════

import { ModelProvider, ReflectionResult } from '../types';
import { MemoryManager } from '../hippocampus/memory-manager';
import { KnowledgeGraph } from '../hippocampus/knowledge-graph';
import type { BehaviorEngine } from './behavior-engine';
import { STOPWORDS } from './behavior-engine';
import logger from '../utils/logger';

export class Reflector {
  private provider: ModelProvider;
  private memory: MemoryManager;
  private behaviorEngine: BehaviorEngine | null = null;
  private knowledgeGraph: KnowledgeGraph | null = null;

  constructor(provider: ModelProvider, memory: MemoryManager) {
    this.provider = provider;
    this.memory = memory;
  }

  /** Set BehaviorEngine for feeding behavioral events */
  setBehaviorEngine(engine: BehaviorEngine): void {
    this.behaviorEngine = engine;
  }

  /** Set KnowledgeGraph for entity extraction */
  setKnowledgeGraph(kg: KnowledgeGraph): void {
    this.knowledgeGraph = kg;
  }

  /**
   * Analyze a completed interaction and extract learnings.
   * Runs ASYNC — does not block the user response.
   */
  async reflect(
    userMessage: string,
    assistantResponse: string,
    toolsUsed: string[],
    sessionId: string,
    channel: string
  ): Promise<ReflectionResult> {
    const currentFacts = this.memory.semantic.getAll(50);
    const factsStr =
      currentFacts.map((f) => `- ${f.key}: ${f.value}`).join('\n') ||
      '(ninguno)';

    try {
      const response = await this.provider.chat(
        `Eres el módulo de reflexión de ATLAS. Analizás interacciones y extraés aprendizajes.

Responde ÚNICAMENTE con JSON válido:
{
  "facts": [
    { "key": "clave_descriptiva", "value": "información", "confidence": 0.9 }
  ],
  "qualityScore": 8,
  "qualityNotes": "La respuesta fue directa y resolvió la tarea",
  "patternsDetected": [],
  "skillGaps": [],
  "improvements": [],
  "corrections": []
}

REGLAS para extraer hechos:
- Solo extraer información NUEVA que no esté en los hechos existentes
- key debe ser descriptiva y snake_case (ej: "lenguaje_preferido", "tienda_favorita")
- confidence: 0.5 = mencionado indirectamente, 0.8 = dicho claramente, 1.0 = confirmado explícitamente
- NO extraer hechos triviales o obvios
- SÍ extraer: preferencias, datos personales/profesionales, patrones de comportamiento
- Si no hay hechos nuevos, devolver facts: []
- qualityScore: 1-10 (10 = perfecta)
- patternsDetected: patrones de uso del usuario
- skillGaps: herramientas o capacidades que harían falta
- improvements: qué se podría mejorar en la respuesta

REGLAS para CORRECCIONES (Correction Learning):
- Si el usuario corrige a ATLAS ("no, era X", "eso está mal", "te equivocaste", "no es así"),
  extraer la corrección como un objeto: { "wrong": "lo que ATLAS dijo mal", "correct": "lo correcto", "context": "en qué contexto" }
- corrections: array de correcciones detectadas (vacío si no hubo corrección)
- Si una corrección invalida un hecho existente, agregar un fact con la información correcta (confidence 1.0)`,
        [
          {
            role: 'user',
            content: `HECHOS EXISTENTES:
${factsStr}

INTERACCIÓN:
Canal: ${channel}
Usuario: "${userMessage}"
ATLAS: "${assistantResponse.substring(0, 1500)}"
Tools usados: ${toolsUsed.join(', ') || 'ninguno'}
Hora: ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`,
          },
        ]
      );

      const cleaned = response.content.replace(/```json?|```/g, '').trim();
      const result = JSON.parse(cleaned) as ReflectionResult;

      // Save new facts to memory
      let factsLearned = 0;
      for (const fact of result.facts || []) {
        if (fact.key && fact.value) {
          this.memory.saveFact(
            fact.key,
            fact.value,
            'reflection',
            fact.confidence ?? 0.8
          );
          factsLearned++;
        }
      }

      // Save corrections as high-confidence facts
      const corrections = (result as any).corrections || [];
      for (const correction of corrections) {
        if (correction.wrong && correction.correct) {
          this.memory.saveFact(
            `correccion_${Date.now()}`,
            `CORRECCIÓN: "${correction.wrong}" → "${correction.correct}" (contexto: ${correction.context || 'general'})`,
            'correction_learning',
            1.0
          );
          logger.info('Correction learned', { wrong: correction.wrong, correct: correction.correct });
        }
      }

      // Save the reflection itself
      this.memory.saveReflection(sessionId, JSON.stringify(result));

      if (factsLearned > 0) {
        logger.info(`Reflector: ${factsLearned} hechos aprendidos`, {
          facts: result.facts.map((f) => f.key),
          quality: result.qualityScore,
        });
      }

      // Feed behavior engine with structured events
      if (this.behaviorEngine) {
        try {
          for (const tool of toolsUsed) {
            this.behaviorEngine.recordEvent('tool_use', tool, channel, sessionId);
          }
          const keywords = this.extractTopKeywords(userMessage, 3);
          for (const kw of keywords) {
            this.behaviorEngine.recordEvent('topic', kw, channel, sessionId);
          }
          this.behaviorEngine.recordEvent('session_activity', channel, channel, sessionId);
          for (const pattern of result.patternsDetected || []) {
            this.behaviorEngine.recordEvent('pattern', pattern, channel, sessionId, { source: 'reflector' });
          }
        } catch (err) {
          logger.debug('BehaviorEngine feed failed (non-critical)', { error: err });
        }
      }

      // Extract entities to Knowledge Graph (async, non-blocking)
      if (this.knowledgeGraph) {
        this.knowledgeGraph
          .extractFromConversation(userMessage, assistantResponse, channel)
          .catch(err => logger.debug('KG extraction failed (non-critical)', { error: err }));
      }

      return result;
    } catch (err) {
      logger.debug('Reflection parse failed (non-critical)', { error: err });
      return {
        facts: [],
        qualityScore: 0,
        qualityNotes: 'Reflexión falló',
        patternsDetected: [],
        skillGaps: [],
        improvements: [],
      };
    }
  }

  /**
   * Deep reflection — periodic meta-analysis across many interactions.
   * Runs every N interactions to find high-level patterns.
   */
  async deepReflection(lastN: number = 50): Promise<string> {
    const recentEpisodes = this.memory.episodic.getRecent(lastN);
    const recentReflections = this.memory.getRecentReflections(20);

    const episodesSummary = recentEpisodes
      .map(
        (e) =>
          `[${e.timestamp}] ${e.role}: ${e.content.substring(0, 200)}`
      )
      .join('\n');

    const reflectionsSummary = recentReflections
      .map((r) => r.insight.substring(0, 200))
      .join('\n');

    try {
      const response = await this.provider.chat(
        `Eres el módulo de meta-aprendizaje de ATLAS. Analizá las últimas interacciones
y reflexiones para identificar patrones de alto nivel.

Respondé con:
1. Patrones de uso del usuario (horarios, temas frecuentes, preferencias)
2. Áreas donde ATLAS podría mejorar
3. Skills que deberían crearse para automatizar tareas repetitivas
4. Cambios recomendados al comportamiento de ATLAS`,
        [
          {
            role: 'user',
            content: `ÚLTIMAS ${lastN} INTERACCIONES:
${episodesSummary || '(ninguna)'}

REFLEXIONES RECIENTES:
${reflectionsSummary || '(ninguna)'}`,
          },
        ]
      );

      // Save as deep reflection
      this.memory.saveReflection('meta', response.content, 'deep_reflection');
      logger.info('Deep reflection completed');
      return response.content;
    } catch (err) {
      logger.warn('Deep reflection failed', { error: err });
      return '';
    }
  }

  /** Extract top N keywords from text (sync, no AI) */
  private extractTopKeywords(text: string, n: number): string[] {
    const words = text
      .toLowerCase()
      .replace(/[^\w\sáéíóúñü]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w));

    const freq = new Map<string, number>();
    for (const word of words) {
      freq.set(word, (freq.get(word) || 0) + 1);
    }

    return Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([word]) => word);
  }
}

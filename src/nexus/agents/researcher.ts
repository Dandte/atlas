// ═══════════════════════════════════════
// ATLAS — Researcher Agent
// ═══════════════════════════════════════

import { AgentDefinition } from '../../types';

export const ResearcherAgent: AgentDefinition = {
  id: 'researcher',
  name: 'researcher',
  displayName: 'Research Analyst',
  description: 'Experto en investigación, búsqueda de información, comparaciones, análisis de mercado, y síntesis de datos de múltiples fuentes.',
  systemPrompt: `Sos el módulo de investigación de ATLAS.

Tu expertise:
- Búsqueda y síntesis de información de múltiples fuentes
- Análisis de mercado y competencia
- Comparaciones de productos, tecnologías, servicios
- Tendencias de industria
- Due diligence e investigación de empresas
- Fact-checking y verificación

Cómo respondés:
- Siempre citá fuentes cuando sea posible
- Presentá datos de forma comparativa: tablas, rankings
- Distinguí entre hechos verificados y opiniones/estimaciones
- Si algo no se puede verificar, decilo
- Resumí primero, detallá después
- Identificá sesgos en las fuentes
- Para análisis de mercado: incluí números, market share, tendencias`,

  preferredModel: 'claude',
  preferredTools: ['web_search', 'web_fetch', 'laravel_api'],
  triggerKeywords: [
    'investigá', 'buscá', 'comparar', 'comparame', 'análisis',
    'mercado', 'tendencia', 'competencia', 'alternativas',
    'qué es', 'cómo funciona', 'cuál es mejor', 'diferencias',
    'pros y contras', 'review', 'opiniones', 'ranking',
    'noticias', 'actualidad', 'novedades',
  ],
  triggerPatterns: [
    /investig(á|ar)/i,
    /busc(á|ar)\s+(info|información|datos)/i,
    /compar(á|ar|ame)/i,
    /qué\s+(es|son|significa)/i,
    /cuál\s+(es\s+)?(mejor|peor|más)/i,
    /diferencias?\s+entre/i,
    /pros\s+y\s+contras/i,
  ],
  capabilities: [
    'web_research', 'market_analysis', 'comparison',
    'fact_checking', 'trend_analysis', 'competitive_intelligence',
  ],
  temperature: 0.4,
  maxTokens: 6144,
  enabled: true,
};

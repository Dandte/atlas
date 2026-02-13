// ═══════════════════════════════════════
// ATLAS — Business Agent
// ═══════════════════════════════════════

import { AgentDefinition } from '../../types';

export const BusinessAgent: AgentDefinition = {
  id: 'business',
  name: 'business',
  displayName: 'Business Analyst',
  description: 'Experto en análisis de negocio, ventas, inventario, métricas comerciales, y estrategia. Conoce las operaciones de Gigamovil y Kredifiamos.',
  systemPrompt: `Sos el módulo de análisis de negocio de ATLAS.

Tu expertise:
- Análisis de ventas: tendencias, comparaciones, proyecciones
- Gestión de inventario: stock bajo, rotación, optimización
- Métricas financieras: márgenes, costos, rentabilidad
- Estrategia comercial: pricing, competencia, oportunidades
- Operaciones retail: performance de tiendas, personal, flujo

Cómo respondés:
- Siempre incluí datos concretos cuando estén disponibles
- Usá comparaciones: vs ayer, vs semana pasada, vs mes pasado
- Identificá anomalías sin que te las pidan
- Sugerí acciones concretas basadas en datos
- Si faltan datos, pedí los que necesitás
- Formateá números: $4.2M, 12.5%, +8% vs ayer`,

  preferredModel: 'claude',
  preferredTools: ['laravel_api', 'database_query', 'web_search'],
  triggerKeywords: [
    'ventas', 'inventario', 'stock', 'tienda', 'tiendas', 'negocio',
    'facturación', 'margen', 'precio', 'clientes', 'productos',
    'gigamovil', 'kredifiamos', 'financiamiento', 'cartera',
    'meta', 'cuota', 'vendedor', 'comisión', 'reporte',
  ],
  triggerPatterns: [
    /vent(as|ió|imos)/i,
    /cuánt(o|a)s?\s+(se\s+)?vend/i,
    /stock|inventario/i,
    /tienda\s+\w+/i,
    /repor(te|tar)/i,
  ],
  capabilities: [
    'sales_analysis', 'inventory_management', 'financial_metrics',
    'store_performance', 'business_strategy',
  ],
  temperature: 0.3,
  maxTokens: 4096,
  enabled: true,
};

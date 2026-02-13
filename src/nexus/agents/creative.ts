// ═══════════════════════════════════════
// ATLAS — Creative Agent
// ═══════════════════════════════════════

import { AgentDefinition } from '../../types';

export const CreativeAgent: AgentDefinition = {
  id: 'creative',
  name: 'creative',
  displayName: 'Creative Writer',
  description: 'Experto en creación de contenido, redacción, comunicación, copywriting, marketing, y presentaciones.',
  systemPrompt: `Sos el módulo creativo de ATLAS.

Tu expertise:
- Copywriting: títulos, descripciones, CTAs, ads
- Contenido de redes sociales: posts, captions, hashtags
- Comunicación empresarial: emails, memos, presentaciones
- Documentación técnica: README, guías, manuales
- Naming: nombres de productos, marcas, proyectos
- Storytelling: narrativas de marca, pitch decks

Cómo respondés:
- Proponé mínimo 2-3 variantes cuando sea creativo (diferente tono/approach)
- Adaptá el tono al canal: LinkedIn ≠ Instagram ≠ WhatsApp ≠ email formal
- Sé directo — no des sermones sobre "la importancia del buen copy"
- Si es para redes: incluí hashtags y formateado listo para copiar
- Para emails: incluí subject line
- Para presentaciones: estructura de slides
- Conocé el negocio del usuario (retail de celulares, financiamiento)`,

  preferredModel: 'claude',
  preferredTools: ['web_search', 'memory_recall'],
  triggerKeywords: [
    'escribí', 'redactá', 'post', 'publicación', 'email',
    'copy', 'texto', 'contenido', 'caption', 'redes',
    'instagram', 'facebook', 'linkedin', 'twitter', 'tiktok',
    'presentación', 'pitch', 'propuesta', 'slogan',
    'nombre', 'naming', 'marca', 'marketing',
  ],
  triggerPatterns: [
    /escrib(í|ir|ime)/i,
    /redact(á|ar)/i,
    /hac(é|er)\s+(un|una)\s+(post|email|mensaje|texto)/i,
    /para\s+(redes|instagram|linkedin|facebook)/i,
    /cómo\s+(suena|queda)/i,
    /propon(é|er)\s+(un\s+)?(nombre|slogan|título)/i,
  ],
  capabilities: [
    'copywriting', 'social_media', 'email_writing',
    'documentation', 'naming', 'storytelling',
  ],
  temperature: 0.7,
  maxTokens: 4096,
  enabled: true,
};

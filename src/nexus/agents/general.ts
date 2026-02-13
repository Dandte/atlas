// ═══════════════════════════════════════
// ATLAS — General Agent (fallback)
// ═══════════════════════════════════════

import { AgentDefinition } from '../../types';

export const GeneralAgent: AgentDefinition = {
  id: 'general',
  name: 'general',
  displayName: 'General Assistant',
  description: 'Asistente general para tareas que no encajan en ningún agente especializado. Conversación casual, preguntas generales, tareas misceláneas.',
  systemPrompt: `Sos ATLAS, el asistente personal de Jose.
Respondé de forma natural y directa. Para tareas especializadas,
los otros módulos se encargan — vos manejás todo lo demás.`,

  preferredModel: 'claude',
  preferredTools: ['web_search', 'shell', 'memory_recall', 'memory_save'],
  triggerKeywords: [],
  triggerPatterns: [],
  capabilities: ['general_conversation', 'task_management', 'miscellaneous'],
  temperature: 0.5,
  maxTokens: 4096,
  enabled: true,
};

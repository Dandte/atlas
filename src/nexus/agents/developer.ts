// ═══════════════════════════════════════
// ATLAS — Developer Agent
// ═══════════════════════════════════════

import { AgentDefinition } from '../../types';

export const DeveloperAgent: AgentDefinition = {
  id: 'developer',
  name: 'developer',
  displayName: 'Software Developer',
  description: 'Experto en desarrollo de software. Laravel, PHP, TypeScript, JavaScript, MySQL, APIs, arquitectura de software, debugging, y code review.',
  systemPrompt: `Sos el módulo de desarrollo de software de ATLAS.

Tu expertise:
- Backend: Laravel, PHP 8+, MySQL, REST APIs, microservicios
- Frontend: JavaScript, TypeScript, Vue.js, React
- Arquitectura: MVC, multi-tenant, event-driven, SOLID
- DevOps: Git, CI/CD, testing, Docker
- Game dev: C++, OpenGL, voxel engines (proyecto ASTRALIA)
- General: Python, Node.js, scripting

Cómo respondés:
- Código limpio, con tipos, sin comentarios obvios
- Si hay un bug: primero diagnosticá la causa raíz, luego proponé fix
- Para refactors: explicá el POR QUÉ antes del QUÉ
- Incluí manejo de errores siempre
- Si el usuario dice "arreglá", arreglá. No pidás permiso para cada cambio.
- Para código largo: primero estructura, luego detalle
- Usá los patrones y convenciones que el usuario ya usa en su proyecto`,

  preferredModel: 'claude',
  preferredTools: ['shell', 'file', 'git', 'database_query'],
  triggerKeywords: [
    'código', 'code', 'bug', 'error', 'función', 'clase', 'método',
    'laravel', 'php', 'javascript', 'typescript', 'python', 'api',
    'refactor', 'review', 'test', 'migration', 'modelo', 'controller',
    'ruta', 'endpoint', 'query', 'eloquent', 'vue', 'react',
    'git', 'commit', 'branch', 'merge', 'pull', 'push',
    'astralia', 'opengl', 'voxel', 'c++',
  ],
  triggerPatterns: [
    /arregl(á|a|ar)\s+(el|este|un)\s+(bug|error|código)/i,
    /cre(á|a|ar)\s+(un|una)\s+(función|clase|endpoint|api|ruta)/i,
    /por\s+qué\s+(falla|no\s+funciona|tira\s+error)/i,
    /hacé\s+(un|una)\s+(migration|modelo|controller)/i,
    /\.(php|js|ts|py|cpp|vue|jsx)\b/i,
    /cómo\s+(hago|implemento|resuelvo)/i,
  ],
  capabilities: [
    'code_writing', 'debugging', 'code_review', 'architecture',
    'api_development', 'database_design', 'testing',
  ],
  temperature: 0.3,
  maxTokens: 8192,
  enabled: true,
};

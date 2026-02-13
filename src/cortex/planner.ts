// ═══════════════════════════════════════
// ATLAS — Planner
// Decomposes complex tasks into plans
// ═══════════════════════════════════════

import { ModelProvider, ToolDefinition, WorkingMemoryContext } from '../types';
import logger from '../utils/logger';

// ── Plan Types (internal) ──

export interface PlanStep {
  id: number;
  description: string;
  tool: string;
  params: Record<string, any>;
  dependsOn: number[];
  onFailure: 'abort' | 'skip' | 'retry';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  result?: any;
}

export interface Plan {
  goal: string;
  reasoning: string;
  steps: PlanStep[];
  successCriteria: string;
  estimatedSteps: number;
}

export interface PlanExecutionResult {
  plan: Plan;
  success: boolean;
  results: Map<number, any>;
}

// ── Planner ──

export class Planner {
  private provider: ModelProvider;

  constructor(provider: ModelProvider) {
    this.provider = provider;
  }

  /**
   * Generate a structured plan from a goal.
   * Used for explicit plan requests or proactive tasks (Sentinel).
   */
  async createPlan(
    goal: string,
    context: WorkingMemoryContext,
    availableTools: ToolDefinition[]
  ): Promise<Plan> {
    const toolList = availableTools
      .map((t) => `- ${t.name}: ${t.description}`)
      .join('\n');

    const factsSummary = context.relevantFacts
      .map((f) => `- ${f.key}: ${f.value}`)
      .join('\n');

    const response = await this.provider.chat(
      `Eres el módulo de planificación de ATLAS. Tu trabajo es descomponer
objetivos complejos en planes ejecutables.

Responde ÚNICAMENTE con JSON válido, sin texto adicional:
{
  "goal": "objetivo",
  "reasoning": "por qué este approach",
  "steps": [
    {
      "id": 1,
      "description": "qué hace",
      "tool": "nombre_del_tool",
      "params": {},
      "dependsOn": [],
      "onFailure": "abort"
    }
  ],
  "successCriteria": "cómo verificar éxito",
  "estimatedSteps": 3
}`,
      [
        {
          role: 'user',
          content: `OBJETIVO: ${goal}

TOOLS DISPONIBLES:
${toolList}

CONTEXTO:
Fecha: ${context.temporal.datetime}
${factsSummary ? `Hechos relevantes:\n${factsSummary}` : ''}`,
        },
      ]
    );

    try {
      const cleaned = response.content
        .replace(/```json?|```/g, '')
        .trim();
      const plan = JSON.parse(cleaned) as Plan;

      // Ensure all steps have proper status
      for (const step of plan.steps) {
        step.status = 'pending';
      }

      logger.info('Plan created', {
        goal,
        steps: plan.steps.length,
        reasoning: plan.reasoning,
      });

      return plan;
    } catch (err) {
      logger.error('Failed to parse plan from model response', { error: err });
      throw new Error('No pude generar un plan estructurado. Voy a resolver la tarea directamente.');
    }
  }

  /**
   * Execute a plan step by step.
   * Respects dependencies and failure policies.
   */
  async executePlan(
    plan: Plan,
    executeToolFn: (name: string, params: Record<string, any>) => Promise<{ success: boolean; output: string; error?: string }>
  ): Promise<PlanExecutionResult> {
    const results: Map<number, any> = new Map();

    for (const step of plan.steps) {
      // Check dependencies
      const depsCompleted = step.dependsOn.every(
        (depId) =>
          plan.steps.find((s) => s.id === depId)?.status === 'completed'
      );

      if (!depsCompleted) {
        step.status = 'skipped';
        logger.debug(`Plan step ${step.id} skipped: dependencies not met`);
        continue;
      }

      step.status = 'running';
      logger.debug(`Plan step ${step.id}: ${step.description}`);

      // Resolve dynamic references to previous step results
      const resolvedParams = this.resolveParams(step.params, results);

      try {
        const result = await executeToolFn(step.tool, resolvedParams);

        if (result.success) {
          step.status = 'completed';
          step.result = result.output;
          results.set(step.id, result.output);
        } else {
          throw new Error(result.error || 'Tool execution failed');
        }
      } catch (err) {
        step.status = 'failed';
        logger.warn(`Plan step ${step.id} failed`, { error: err });

        if (step.onFailure === 'abort') {
          break;
        } else if (step.onFailure === 'retry') {
          // Retry once
          try {
            const retryResult = await executeToolFn(step.tool, resolvedParams);
            if (retryResult.success) {
              step.status = 'completed';
              step.result = retryResult.output;
              results.set(step.id, retryResult.output);
            }
          } catch {
            // Retry also failed, continue
          }
        }
        // 'skip' just continues to next step
      }
    }

    const success = plan.steps.every(
      (s) => s.status === 'completed' || s.status === 'skipped'
    );

    return { plan, success, results };
  }

  /**
   * Resolve references to previous step results in params.
   * Replaces "step{N}.result" with actual results.
   */
  private resolveParams(
    params: Record<string, any>,
    results: Map<number, any>
  ): Record<string, any> {
    const resolved = { ...params };
    for (const [key, value] of Object.entries(resolved)) {
      if (typeof value === 'string') {
        const match = value.match(/^step(\d+)\.result$/);
        if (match) {
          resolved[key] = results.get(parseInt(match[1])) || value;
        }
      }
    }
    return resolved;
  }
}

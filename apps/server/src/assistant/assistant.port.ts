/**
 * A narrow port the automations engine uses to reach the Computer without importing the
 * AssistantModule — which would create a module cycle (Automations → Assistant → Tools →
 * Automations). AutomationsService resolves this token lazily via ModuleRef; AssistantModule
 * binds it to AssistantService. See docs/assistant-computer.md.
 */
export const ASSISTANT_AUTOMATION_PORT = Symbol('ASSISTANT_AUTOMATION_PORT');

export interface AssistantAutomationPort {
  /**
   * Run the Computer headlessly (no human, read-only tools only) with a prompt and optional
   * event context, returning its final text answer.
   */
  summarizeForAutomation(prompt: string, context?: string): Promise<string>;
}

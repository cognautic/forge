export interface ToolExecutionSuccess<T = unknown> {
  success: true;
  data: T;
}

export interface ToolExecutionFailure {
  success: false;
  error: string;
}

export type ToolExecutionResult<T = unknown> = ToolExecutionSuccess<T> | ToolExecutionFailure;

export interface ToolDefinition<P extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  product: string;
  scopes: string[];
  execute: (params: P, userId: string) => Promise<ToolExecutionResult>;
}

import { gmailTools } from "./tools/gmail";
import { calendarTools } from "./tools/calendar";
import { driveTools } from "./tools/drive";
import { docsTools } from "./tools/docs";
import { sheetsTools } from "./tools/sheets";
import { tasksTools } from "./tools/tasks";
import { contactsTools } from "./tools/contacts";
import { meetTools } from "./tools/meet";

const ALL_TOOLS: ToolDefinition[] = [
  ...gmailTools,
  ...calendarTools,
  ...driveTools,
  ...docsTools,
  ...sheetsTools,
  ...tasksTools,
  ...contactsTools,
  ...meetTools
];

/**
 * Returns all Google tool definitions.
 */
export function getAllTools(): ToolDefinition[] {
  return ALL_TOOLS;
}

/**
 * Returns Google tool definitions for selected products.
 */
export function getToolsForProducts(products: string[]): ToolDefinition[] {
  const allowed = new Set(products);
  return ALL_TOOLS.filter((tool) => allowed.has(tool.product));
}

/**
 * Executes a Google tool by name and returns a structured result.
 */
export async function executeTool(
  toolName: string,
  params: Record<string, unknown>,
  userId: string
): Promise<ToolExecutionResult> {
  try {
    const tool = ALL_TOOLS.find((entry) => entry.name === toolName);
    if (!tool) return { success: false, error: `Unknown Google tool: ${toolName}` };
    return await tool.execute(params, userId);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Returns OpenAI-compatible function schemas for all Google tools.
 */
export function getToolSchemas(): Array<{
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolDefinition["parameters"];
  };
}> {
  return ALL_TOOLS.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
}

import { loadTokens } from "./auth/tokens";
import { connectGoogle, disconnectGoogle, getAuthenticatedClient } from "./auth/oauth";
import { getScopesForProducts, getScopesForTools, type GoogleProduct } from "./auth/scopes";
import { executeTool, getAllTools, getToolSchemas, getToolsForProducts, type ToolExecutionResult } from "./registry";

/**
 * Forge Google Workspace integration facade.
 */
export class GoogleIntegration {
  /**
   * Starts the OAuth connect flow for selected Google products.
   */
  async connect(
    userId: string,
    products?: GoogleProduct[]
  ): Promise<{ success: true; email: string; connectedProducts: GoogleProduct[] } | { success: false; error: string }> {
    const selected = (products?.length ? products : []) as GoogleProduct[];
    const scopes = getScopesForProducts(selected);
    const result = await connectGoogle(userId, scopes);
    if (!result.success) return result;
    return { success: true, email: result.email, connectedProducts: selected };
  }

  /**
   * Returns whether valid Google tokens exist for the user.
   */
  async isConnected(userId: string): Promise<boolean> {
    if (!await loadTokens(userId)) return false;
    try {
      const client = await getAuthenticatedClient(userId);
      if (!client) return false;
      const token = await client.getAccessToken();
      return Boolean(token?.token);
    } catch {
      return false;
    }
  }

  /**
   * Disconnects a user by deleting their saved Google tokens.
   */
  async disconnect(userId: string): Promise<{ success: true }> {
    const result = await disconnectGoogle(userId);
    if (!result.success) throw new Error(result.error);
    return { success: true };
  }

  /**
   * Returns OpenAI-compatible function tool schemas.
   */
  getTools(products?: GoogleProduct[]) {
    if (!products?.length) return getToolSchemas();
    const allowed = new Set(getToolsForProducts(products).map((tool) => tool.name));
    return getToolSchemas().filter((tool) => allowed.has(tool.function.name));
  }

  /**
   * Executes a Google tool for a Forge user.
   */
  async run(toolName: string, params: Record<string, unknown>, userId: string): Promise<ToolExecutionResult> {
    return await executeTool(toolName, params, userId);
  }

  /**
   * Returns the OAuth scopes required for the supplied Google tool names.
   */
  getRequiredScopes(toolNames: string[]): string[] {
    return getScopesForTools(toolNames);
  }
}

export * from "./auth/oauth";
export * from "./auth/scopes";
export * from "./auth/tokens";
export * from "./auth/callback-server";
export * from "./registry";
export * from "./tools/gmail";
export * from "./tools/calendar";
export * from "./tools/drive";
export * from "./tools/docs";
export * from "./tools/sheets";
export * from "./tools/tasks";
export * from "./tools/contacts";
export * from "./tools/meet";

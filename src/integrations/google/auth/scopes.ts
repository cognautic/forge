/**
 * Google OAuth scopes grouped by Forge product area.
 */
export const SCOPES = {
  base: [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/userinfo.email"
  ],
  gmail: [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.labels",
    "https://www.googleapis.com/auth/gmail.readonly"
  ],
  calendar: [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/calendar.events"
  ],
  drive: [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/drive.file"
  ],
  docs: [
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/drive.file"
  ],
  sheets: [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.file"
  ],
  tasks: ["https://www.googleapis.com/auth/tasks"],
  contacts: ["https://www.googleapis.com/auth/contacts"],
  meet: [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/calendar.events"
  ]
} as const;

export type GoogleProduct = Exclude<keyof typeof SCOPES, "base">;

const TOOL_PREFIX_TO_PRODUCT: Record<string, GoogleProduct> = {
  gmail: "gmail",
  calendar: "calendar",
  drive: "drive",
  docs: "docs",
  sheets: "sheets",
  tasks: "tasks",
  contacts: "contacts",
  meet: "meet"
};

/**
 * Returns the scopes needed for a list of Forge Google tool names.
 */
export function getScopesForTools(toolNames: string[]): string[] {
  const scopes = new Set<string>(SCOPES.base);
  for (const toolName of toolNames) {
    const prefix = String(toolName || "").split("_")[0] as keyof typeof TOOL_PREFIX_TO_PRODUCT;
    const product = TOOL_PREFIX_TO_PRODUCT[prefix];
    if (!product) continue;
    for (const scope of SCOPES[product]) scopes.add(scope);
  }
  return [...scopes];
}

/**
 * Returns the scopes needed for one or more Google product groups.
 */
export function getScopesForProducts(products: GoogleProduct[]): string[] {
  const scopes = new Set<string>(SCOPES.base);
  for (const product of products) {
    for (const scope of SCOPES[product]) scopes.add(scope);
  }
  return [...scopes];
}

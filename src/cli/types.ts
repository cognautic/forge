export type ProviderKind =
  | "openai"
  | "google"
  | "anthropic"
  | "openrouter"
  | "groq"
  | "cerebras"
  | "ollama"
  | "custom";

export interface ProviderConfig {
  provider: ProviderKind;
  model: string;
  endpoint?: string;
}

export interface AgentRequest {
  task: string;
  maxSteps?: number;
}

export interface AgentStep {
  step: number;
  action: string;
  result: string;
}

export interface ForgeState {
  projectRoot: string;
  autoApprove: boolean;
  autoContinueMax?: number;
  executionMode?: "safe" | "yolo";
  onboardingComplete: boolean;
  browserExecutablePath?: string;
  searchMode?: "safe" | "manual";
  provider: ProviderConfig;
  apiKeys: Partial<Record<ProviderKind, string>>;
}

export type CoworkRole = "architect" | "planner" | "executor" | "reviewer" | "memory_manager";

export type TaskStatus = "proposed" | "approved" | "in_progress" | "under_review" | "completed" | "archived";

export interface WorkspaceObjective {
  text: string;
  updatedAt: string;
}

export interface WorkspaceTask {
  id: string;
  title: string;
  status: TaskStatus;
  ownerRole: CoworkRole;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceArtifact {
  id: string;
  taskId: string;
  type: string;
  ref: string;
  createdAt: string;
}

export interface WorkspaceEvent {
  id: string;
  ts: string;
  kind: "objective" | "task" | "artifact" | "review" | "agent";
  detail: string;
}

export interface CoworkWorkspace {
  version: number;
  projectRoot: string;
  objective: WorkspaceObjective;
  roles: Record<CoworkRole, string>;
  tasks: WorkspaceTask[];
  artifacts: WorkspaceArtifact[];
  history: WorkspaceEvent[];
  memory: {
    summary: string;
    lastIntent: string;
    recentTurns: Array<{
      ts: string;
      user: string;
      ai: string;
    }>;
  };
}

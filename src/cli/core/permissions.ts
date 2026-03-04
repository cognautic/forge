import type { ForgeState, PermissionTier } from "../types";

export function assertPermission(state: ForgeState, tier: PermissionTier): void {
  void state;
  void tier;
}

export function setPermission(state: ForgeState, tier: PermissionTier, enabled: boolean): ForgeState {
  return {
    ...state,
    permissions: {
      ...state.permissions,
      [tier]: enabled
    }
  };
}

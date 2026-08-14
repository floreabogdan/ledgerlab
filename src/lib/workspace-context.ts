import { HttpError } from "@/lib/api-response";

export type WorkspaceRole = "owner" | "member";
export type WorkspaceType = "personal" | "household";

/**
 * The authorization context for every operation that reads or mutates
 * workspace-owned data. Identity and tenancy deliberately remain separate:
 * `actorUserId` is used for attribution, while `workspaceId` is the only value
 * used in ownership predicates.
 */
export type WorkspaceContext = Readonly<{
  actorUserId: string;
  workspaceId: string;
  role: WorkspaceRole;
}>;

export function requireWorkspaceOwner(
  context: WorkspaceContext,
): asserts context is WorkspaceContext & { role: "owner" } {
  if (context.role !== "owner") {
    throw new HttpError(403, {
      code: "WORKSPACE_OWNER_REQUIRED",
      message: "Workspace owner access is required",
    });
  }
}

/** A stable, non-enumerating response for absent and inaccessible objects. */
export function workspaceEntityNotFound(entity: string): HttpError {
  return new HttpError(404, {
    code: "WORKSPACE_ENTITY_NOT_FOUND",
    message: `${entity} was not found`,
  });
}

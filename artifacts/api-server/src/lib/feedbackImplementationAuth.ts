import type { User } from "@workspace/db/schema";

export const FEEDBACK_IMPLEMENTER_USER_ID_ENV = "FEEDBACK_IMPLEMENTER_USER_ID";

type FeedbackImplementationActor = Pick<User, "id" | "role" | "archivedAt">;

/**
 * The feedback queue is reviewable by every admin, but its implementation
 * handoff is a separate owner capability. Keep that capability server-side,
 * bind it to one authenticated CRM user, and fail closed when unconfigured.
 */
export function canStartFeedbackImplementation(
  actor: FeedbackImplementationActor | undefined,
  configuredUserId = process.env[FEEDBACK_IMPLEMENTER_USER_ID_ENV],
): boolean {
  const implementerUserId = configuredUserId?.trim();
  return Boolean(
    actor &&
    actor.role === "admin" &&
    !actor.archivedAt &&
    implementerUserId &&
    actor.id === implementerUserId,
  );
}

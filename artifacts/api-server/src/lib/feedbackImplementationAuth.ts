import type { User } from "@workspace/db/schema";

export function canStartFeedbackImplementation(
  actor: User | undefined,
): boolean {
  const configuredUserId = process.env.FEEDBACK_IMPLEMENTER_USER_ID?.trim();
  return Boolean(
    configuredUserId && actor?.role === "admin" && actor.id === configuredUserId,
  );
}
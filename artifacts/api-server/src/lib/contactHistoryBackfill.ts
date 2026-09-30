import { db } from "@workspace/db";
import { googleOauthTokens } from "@workspace/db/schema";
import { isNull } from "drizzle-orm";
import { backfillEmailAddressForUser } from "./gmailBackfill";
import { backfillCalendarAddressForUser } from "./calendarSync";
import { logger } from "./logger";

const inFlight = new Set<string>();

/**
 * Launch a complete, address-scoped Gmail and Google Calendar history search
 * after an email is attached to a CRM person. The work is deliberately
 * detached from the request: adding a contact stays fast while source-specific
 * advisory locks keep it from racing the normal sync workers.
 */
export function queueContactHistoryBackfill(args: {
  personId: string;
  emailAddress: string;
}): void {
  const emailAddress = args.emailAddress.trim().toLowerCase();
  const key = `${args.personId}:${emailAddress}`;
  if (!emailAddress || inFlight.has(key)) return;
  inFlight.add(key);
  void (async () => {
    try {
      const connectedUsers = await db
        .select({ userId: googleOauthTokens.userId })
        .from(googleOauthTokens)
        .where(isNull(googleOauthTokens.revokedAt));
      for (const { userId } of connectedUsers) {
        const [gmail, calendar] = await Promise.all([
          backfillEmailAddressForUser(userId, emailAddress),
          backfillCalendarAddressForUser(userId, emailAddress),
        ]);
        logger.info(
          {
            personId: args.personId,
            emailAddress,
            userId,
            gmail,
            calendar,
          },
          "Contact history backfill completed for connected Google account",
        );
      }
    } catch (err) {
      logger.error(
        { err, personId: args.personId, emailAddress },
        "Contact history backfill failed",
      );
    } finally {
      inFlight.delete(key);
    }
  })();
}

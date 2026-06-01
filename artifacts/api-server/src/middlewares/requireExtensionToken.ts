import type { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { users } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { setAppUser } from "../lib/appRequest";

/**
 * Auth for the extension-facing send endpoint. The tracking extension runs on
 * mail.google.com, so it has no Clerk session cookie. Instead the user pastes a
 * per-user "extension token" (generated in Settings) into the extension; the
 * extension sends it as `X-Extension-Token` and we resolve it back to the owning
 * CRM user. We then have the user id needed to pull their Google grant and send
 * on their behalf.
 *
 * Unlike the unauthenticated pixel/register paths, sending email on a user's
 * behalf is sensitive, so this path is NOT open — a valid token is required.
 */
export async function requireExtensionToken(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers["x-extension-token"];
  const token =
    typeof header === "string"
      ? header.trim()
      : Array.isArray(header)
        ? String(header[0]).trim()
        : "";
  if (!token) {
    res
      .status(401)
      .json({ error: "unauthorized", message: "Missing extension token" });
    return;
  }
  const user = await db
    .select()
    .from(users)
    .where(eq(users.extensionToken, token))
    .then((r) => r[0]);
  if (!user || user.archivedAt) {
    res
      .status(401)
      .json({ error: "unauthorized", message: "Invalid extension token" });
    return;
  }
  setAppUser(req, user);
  next();
}

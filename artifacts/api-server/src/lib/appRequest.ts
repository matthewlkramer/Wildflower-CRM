import type { Request } from "express";
import type { User } from "@workspace/db/schema";

export interface AppRequest extends Request {
  appUser?: User;
}

export function getAppUser(req: Request): User | undefined {
  return (req as AppRequest).appUser;
}

export function setAppUser(req: Request, user: User): void {
  (req as AppRequest).appUser = user;
}

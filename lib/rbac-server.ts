import type { Status } from "@prisma/client";
import { ROLE_LEVELS, type Role } from "./rbac";
import { getSessionUser } from "./session";

export type RequestUser = {
  id: string;
  name: string;
  role: Role;
  status: Status;
};

export const getRequestUser = async (request: Request): Promise<RequestUser> => {
  const sessionUser = await getSessionUser(request);
  if (!sessionUser) {
    // INACTIVE, not ACTIVE, so an unauthenticated caller can never satisfy a status === "ACTIVE" gate.
    return { id: "", name: "", role: "Intern", status: "INACTIVE" };
  }
  return { id: sessionUser.id, name: sessionUser.name, role: sessionUser.role, status: sessionUser.status };
};

export const requireMinLevel = (role: Role, minLevel: number) => {
  const level = ROLE_LEVELS[role] ?? 4;
  return level <= minLevel;
};

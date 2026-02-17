import { ROLE_LEVELS, type Role } from "./rbac";
import { getSessionUser } from "./session";

export type RequestUser = {
  id: string;
  role: Role;
};

export const getRequestUser = async (request: Request): Promise<RequestUser> => {
  const sessionUser = await getSessionUser(request);
  if (!sessionUser) {
    return { id: "", role: "Intern" };
  }
  return { id: sessionUser.id, role: sessionUser.role };
};

export const requireMinLevel = (role: Role, minLevel: number) => {
  const level = ROLE_LEVELS[role] ?? 4;
  return level <= minLevel;
};

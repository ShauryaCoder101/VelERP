import type { Status } from "@prisma/client";
import { ROLE_LEVELS, type Role } from "./rbac";
import { getSessionUser } from "./session";

export type RequestUser = {
  id: string;
  name: string;
  role: Role;
  status: Status;
};

/* getRequestUser means "an employee".
 *
 * Third-party photographers are ordinary User rows, so without this they would
 * be admitted everywhere an "any logged-in user" check appears — and
 * Photographer sits at ROLE_LEVELS 4, the same level as Intern, so
 * requireMinLevel would wave them through to the research module, the sales
 * pipeline and everything else. Returning the anonymous shape for a
 * photographer session shuts every existing employee route on them with no
 * per-route change.
 *
 * getUploader below is the ONLY door a photographer can come through, and only
 * the upload routes use it. */
export const getRequestUser = async (request: Request): Promise<RequestUser> => {
  const sessionUser = await getSessionUser(request);
  if (!sessionUser || sessionUser.role === "Photographer") {
    // INACTIVE, not ACTIVE, so an unauthenticated caller can never satisfy a status === "ACTIVE" gate.
    return { id: "", name: "", role: "Intern", status: "INACTIVE" };
  }
  return { id: sessionUser.id, name: sessionUser.name, role: sessionUser.role, status: sessionUser.status };
};

export type Uploader = {
  id: string;
  name: string;
  role: Role;
  status: Status;
  isPhotographer: boolean;
};

/* Any active signed-in user, employee OR third-party photographer. Callers must
   branch on isPhotographer: a photographer is confined to the events they hold
   an active grant for, and is charged against a quota. */
export const getUploader = async (request: Request): Promise<Uploader | null> => {
  const sessionUser = await getSessionUser(request);
  if (!sessionUser) return null;
  return {
    id: sessionUser.id,
    name: sessionUser.name,
    role: sessionUser.role,
    status: sessionUser.status,
    isPhotographer: sessionUser.role === "Photographer"
  };
};

export const requireMinLevel = (role: Role, minLevel: number) => {
  const level = ROLE_LEVELS[role] ?? 4;
  return level <= minLevel;
};

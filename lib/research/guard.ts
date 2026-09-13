/* Access control for the research module: every logged-in user (level 4).

   getRequestUser fails OPEN - an unauthenticated request comes back as an
   anonymous Intern with an empty id - so the empty-id check is what actually
   keeps strangers out. Never call requireMinLevel on its own here. */

import { getRequestUser, requireMinLevel, type RequestUser } from "../rbac-server";

export async function requireResearchUser(request: Request): Promise<RequestUser | null> {
  const user = await getRequestUser(request);
  if (!user.id) return null;
  if (!requireMinLevel(user.role, 4)) return null;
  return user;
}

export const forbidden = () => new Response("Forbidden", { status: 403 });

export const badRequest = (message: string) =>
  Response.json({ error: message }, { status: 400 });

export const notFound = (message = "Not found") => Response.json({ error: message }, { status: 404 });

import { getSessionUser } from "../../../../lib/session";

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }
  return Response.json(user);
}

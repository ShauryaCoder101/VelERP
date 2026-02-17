import { deleteSession, clearSessionCookie } from "../../../../lib/session";

export async function POST(request: Request) {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const tokenMatch = cookieHeader.match(/velocity_session=([^;]+)/);
  if (tokenMatch?.[1]) {
    await deleteSession(tokenMatch[1]);
  }

  return new Response(null, {
    status: 204,
    headers: {
      "Set-Cookie": clearSessionCookie()
    }
  });
}

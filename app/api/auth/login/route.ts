import bcrypt from "bcryptjs";
import { prisma } from "../../../../lib/db";
import { createSession, getSessionCookie } from "../../../../lib/session";

export async function POST(request: Request) {
  const body = await request.json();
  const user = await prisma.user.findUnique({ where: { email: body.email } });
  if (!user) {
    return new Response("Invalid credentials", { status: 401 });
  }

  const isValid = await bcrypt.compare(body.password ?? "", user.passwordHash);
  if (!isValid) {
    return new Response("Invalid credentials", { status: 401 });
  }

  const { token, expiresAt } = await createSession(user.id);
  const cookie = getSessionCookie(token, expiresAt);

  return new Response(
    JSON.stringify({
      id: user.id,
      uid: user.uid,
      name: user.name,
      role: user.role,
      email: user.email
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": cookie
      }
    }
  );
}

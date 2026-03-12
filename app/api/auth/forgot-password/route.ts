import { prisma } from "../../../../lib/db";
import { sendOtpEmail } from "../../../../lib/email";
import crypto from "crypto";

export async function POST(request: Request) {
  const body = await request.json();
  const { email } = body;

  if (!email) {
    return Response.json({ error: "Email is required" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (!user) {
    return Response.json({ ok: true });
  }

  const otp = crypto.randomInt(100000, 999999).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await prisma.passwordReset.create({
    data: { email: user.email, otp, expiresAt }
  });

  await sendOtpEmail(user.email, otp);

  return Response.json({ ok: true });
}

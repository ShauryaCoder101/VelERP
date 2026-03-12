import { prisma } from "../../../../lib/db";
import bcrypt from "bcryptjs";

export async function POST(request: Request) {
  const body = await request.json();
  const { email, otp, newPassword } = body;

  if (!email || !otp || !newPassword) {
    return Response.json({ error: "All fields are required" }, { status: 400 });
  }

  if (newPassword.length < 6) {
    return Response.json({ error: "Password must be at least 6 characters" }, { status: 400 });
  }

  const resetRecord = await prisma.passwordReset.findFirst({
    where: {
      email: email.toLowerCase().trim(),
      otp,
      used: false,
      expiresAt: { gt: new Date() }
    },
    orderBy: { createdAt: "desc" }
  });

  if (!resetRecord) {
    return Response.json({ error: "Invalid or expired OTP" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { email: resetRecord.email } });
  if (!user) {
    return Response.json({ error: "User not found" }, { status: 404 });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);

  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
    prisma.passwordReset.update({ where: { id: resetRecord.id }, data: { used: true } })
  ]);

  return Response.json({ ok: true });
}

import { prisma } from "../../../../../lib/db";
import { verifyShareToken } from "../../../../../lib/shareToken";
import { signMediaDownloads } from "../../../../../lib/media-items";

/* Public endpoint, same grant as GET ../route.ts: the token is the whole
   authorisation and this must check it exactly as strictly.

   The batching rationale and the id cap live with the signing itself, in
   lib/media-items.ts. What stays here is the part that is specific to a client
   link: verifying the token and honouring a revocation. */

export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const payload = verifyShareToken(token);
  if (!payload) {
    return Response.json({ error: "This link is invalid or has expired." }, { status: 410 });
  }

  /* Same fault-tolerant revocation check as GET: a missing table must not break
     delivery, but a revoked row beats a valid signature. */
  let record: { revokedAt: Date | null } | null = null;
  try {
    record = await prisma.mediaShare.findUnique({ where: { token }, select: { revokedAt: true } });
  } catch {
    record = null;
  }
  if (record?.revokedAt) {
    return Response.json({ error: "This link has been withdrawn." }, { status: 410 });
  }

  const body = await request.json().catch(() => null);
  const ids = Array.isArray(body?.ids) ? (body.ids as unknown[]).filter((v): v is string => typeof v === "string") : [];

  // Never outlive the link itself.
  const remaining = Math.floor((payload.x - Date.now()) / 1000);
  const expiresIn = Math.max(60, Math.min(60 * 60, remaining));

  const urls = await signMediaDownloads({ eventId: payload.e, folder: payload.f, ids, expiresIn });
  return Response.json({ urls });
}

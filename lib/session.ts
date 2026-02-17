import crypto from "crypto";
import { prisma } from "./db";
import { normalizeRole, type Role } from "./rbac";

const SESSION_COOKIE = "velocity_session";
const SESSION_TTL_DAYS = 7;

type SessionUser = {
  id: string;
  role: Role;
  name: string;
  email: string;
};

const parseCookies = (cookieHeader: string | null) => {
  if (!cookieHeader) return {};
  return cookieHeader.split(";").reduce<Record<string, string>>((acc, part) => {
    const [key, ...rest] = part.trim().split("=");
    acc[key] = decodeURIComponent(rest.join("="));
    return acc;
  }, {});
};

export const createSession = async (userId: string) => {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + SESSION_TTL_DAYS);

  await prisma.session.create({
    data: {
      token,
      userId,
      expiresAt
    }
  });

  return { token, expiresAt };
};

export const deleteSession = async (token: string) => {
  await prisma.session.deleteMany({ where: { token } });
};

export const getSessionUser = async (request: Request): Promise<SessionUser | null> => {
  const cookies = parseCookies(request.headers.get("cookie"));
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;

  const session = await prisma.session.findFirst({
    where: { token, expiresAt: { gt: new Date() } },
    include: { user: true }
  });

  if (!session) return null;

  return {
    id: session.user.id,
    role: normalizeRole(session.user.role),
    name: session.user.name,
    email: session.user.email
  };
};

export const getSessionCookie = (token: string, expiresAt: Date) =>
  `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expiresAt.toUTCString()}`;

export const clearSessionCookie = () =>
  `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

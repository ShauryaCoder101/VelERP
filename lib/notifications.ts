import { prisma } from "./db";

export async function createNotification(actorId: string, type: string, title: string, body: string) {
  return prisma.notification.create({
    data: { actorId, type, title, body }
  });
}

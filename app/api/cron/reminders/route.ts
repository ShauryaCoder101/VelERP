import { prisma } from "../../../../lib/db";
import { sendReminderEmail, reminderRow } from "../../../../lib/email";

/* Runs on a Vercel cron. The route is publicly addressable, so it refuses
   anything without the shared secret — otherwise a stranger could make the
   system mail your staff, repeatedly.

   Everything here is read-only apart from stamping remindedAt, which is what
   stops the same link being chased every single day. */

export const maxDuration = 60;

const DAY_MS = 86_400_000;
const fmt = (d: Date) =>
  d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

const authorised = (request: Request) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed
  return request.headers.get("authorization") === `Bearer ${secret}`;
};

export async function GET(request: Request) {
  if (!authorised(request)) return new Response("Forbidden", { status: 403 });

  const now = new Date();
  const sent: string[] = [];
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";

  /* 1 — client links expiring soon that were never opened.
         The delivery has silently failed and nobody knows yet. */
  type ExpiringShare = {
    id: string;
    folder: string | null;
    expiresAt: Date;
    event: { eventName: string; companyName: string };
    creator: { name: string; email: string };
  };

  // Each reminder stands alone: one failing query must not silence the others.
  let expiring: ExpiringShare[] = [];
  try {
    expiring = await prisma.mediaShare.findMany({
      where: {
        revokedAt: null,
        remindedAt: null,
        viewCount: 0,
        expiresAt: { gt: now, lt: new Date(now.getTime() + 2 * DAY_MS) }
      },
      select: {
        id: true,
        folder: true,
        expiresAt: true,
        event: { select: { eventName: true, companyName: true } },
        creator: { select: { name: true, email: true } }
      }
    });
  } catch {
    expiring = [];
  }

  const byCreator = new Map<string, { name: string; items: typeof expiring }>();
  for (const share of expiring) {
    const entry = byCreator.get(share.creator.email);
    if (entry) entry.items.push(share);
    else byCreator.set(share.creator.email, { name: share.creator.name, items: [share] });
  }

  for (const [email, { name, items }] of byCreator) {
    const ok = await sendReminderEmail(
      email,
      `${items.length} client link${items.length !== 1 ? "s" : ""} expiring unopened`,
      "Client links expiring",
      `${name}, ${items.length === 1 ? "a gallery link you shared has" : "these gallery links have"} not been opened yet and will expire within 48 hours.`,
      items.map((s) =>
        reminderRow(
          `${s.event.eventName} — ${s.event.companyName}`,
          `${s.folder ? `Folder: ${s.folder} · ` : ""}Expires ${fmt(s.expiresAt)} · never opened`
        )
      ),
      "Open the event in the ERP to issue a fresh link, or check the client received the original."
    );
    if (ok) sent.push(`links:${email}`);
  }

  if (expiring.length > 0) {
    await prisma.mediaShare
      .updateMany({ where: { id: { in: expiring.map((s) => s.id) } }, data: { remindedAt: now } })
      .catch(() => {});
  }

  /* 2 — expense claims still awaiting approval. Accountants only. */
  const pendingClaims = await prisma.expenseClaim.findMany({
    where: { status: "INACTIVE" },
    select: {
      id: true,
      submittedAt: true,
      user: { select: { name: true } },
      event: { select: { eventName: true } },
      items: { select: { amount: true } }
    },
    orderBy: { submittedAt: "asc" }
  });

  if (pendingClaims.length > 0) {
    const accountants = await prisma.user.findMany({
      where: { role: "ACCOUNTANT", status: "ACTIVE" },
      select: { email: true, name: true }
    });

    const total = pendingClaims.reduce((s, c) => s + c.items.reduce((n, i) => n + i.amount, 0), 0);

    for (const accountant of accountants) {
      const ok = await sendReminderEmail(
        accountant.email,
        `${pendingClaims.length} expense claim${pendingClaims.length !== 1 ? "s" : ""} awaiting approval`,
        "Claims awaiting approval",
        `${pendingClaims.length} claim${pendingClaims.length !== 1 ? "s are" : " is"} still pending, totalling ₹${total.toLocaleString("en-IN")}.`,
        pendingClaims.slice(0, 25).map((c) =>
          reminderRow(
            `${c.user.name} — ₹${c.items.reduce((n, i) => n + i.amount, 0).toLocaleString("en-IN")}`,
            `${c.event?.eventName ?? "No event"} · submitted ${fmt(c.submittedAt)}`
          )
        ),
        pendingClaims.length > 25 ? `Showing the 25 oldest of ${pendingClaims.length}.` : undefined
      );
      if (ok) sent.push(`claims:${accountant.email}`);
    }
  }

  /* 3 — deals closing within the week, to whoever owns them. */
  const closing = await prisma.deal.findMany({
    where: {
      expectedCloseDate: { gte: now, lt: new Date(now.getTime() + 7 * DAY_MS) },
      stage: { notIn: ["CLOSED_WON", "CLOSED_LOST"] },
      assignedTo: { not: null }
    },
    select: {
      dealName: true,
      amount: true,
      stage: true,
      expectedCloseDate: true,
      assignedToUser: { select: { name: true, email: true } }
    }
  });

  const byOwner = new Map<string, { name: string; items: typeof closing }>();
  for (const deal of closing) {
    if (!deal.assignedToUser) continue;
    const entry = byOwner.get(deal.assignedToUser.email);
    if (entry) entry.items.push(deal);
    else byOwner.set(deal.assignedToUser.email, { name: deal.assignedToUser.name, items: [deal] });
  }

  for (const [email, { name, items }] of byOwner) {
    const ok = await sendReminderEmail(
      email,
      `${items.length} deal${items.length !== 1 ? "s" : ""} closing this week`,
      "Deals closing this week",
      `${name}, ${items.length === 1 ? "this deal has" : "these deals have"} an expected close date in the next seven days.`,
      items.map((d) =>
        reminderRow(
          `${d.dealName} — ₹${d.amount.toLocaleString("en-IN")}`,
          `${d.stage.replace(/_/g, " ").toLowerCase()} · closes ${fmt(d.expectedCloseDate!)}`
        )
      ),
      appUrl ? `Pipeline: ${appUrl}/sales` : undefined
    );
    if (ok) sent.push(`deals:${email}`);
  }

  /* 4 — events that finished a while ago with nothing uploaded. */
  const staleEvents = await prisma.event.findMany({
    where: {
      toDate: { lt: new Date(now.getTime() - 3 * DAY_MS), gt: new Date(now.getTime() - 30 * DAY_MS) },
      uploads: { none: {} }
    },
    select: {
      eventName: true,
      companyName: true,
      toDate: true,
      teamMembers: { select: { user: { select: { name: true, email: true } } } }
    }
  });

  const byMember = new Map<string, { name: string; items: { label: string; meta: string }[] }>();
  for (const event of staleEvents) {
    for (const member of event.teamMembers) {
      const row = {
        label: `${event.eventName} — ${event.companyName}`,
        meta: `Finished ${fmt(event.toDate)} · no photos or video uploaded`
      };
      const entry = byMember.get(member.user.email);
      if (entry) entry.items.push(row);
      else byMember.set(member.user.email, { name: member.user.name, items: [row] });
    }
  }

  for (const [email, { name, items }] of byMember) {
    const ok = await sendReminderEmail(
      email,
      `${items.length} finished event${items.length !== 1 ? "s" : ""} with no media`,
      "Missing event media",
      `${name}, ${items.length === 1 ? "this event has" : "these events have"} finished but nothing has been uploaded yet.`,
      items.map((i) => reminderRow(i.label, i.meta)),
      appUrl ? `Upload from the event page: ${appUrl}/events` : undefined
    );
    if (ok) sent.push(`media:${email}`);
  }

  return Response.json({
    ranAt: now.toISOString(),
    emails: sent.length,
    breakdown: {
      expiringLinks: expiring.length,
      pendingClaims: pendingClaims.length,
      closingDeals: closing.length,
      eventsMissingMedia: staleEvents.length
    }
  });
}

import { prisma } from "../../../../lib/db";
import { sendReminderEmail, reminderRow } from "../../../../lib/email";
import { sweepAbandonedMultipart } from "../../../../lib/multipart-janitor";

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
    eventId: string;
    event: { eventName: string; companyName: string };
    creator: { id: string; name: string; email: string; role: string };
  };

  // Each reminder stands alone: one failing query must not silence the others.
  let expiring: ExpiringShare[] = [];
  try {
    expiring = await prisma.mediaShare.findMany({
      where: {
        revokedAt: null,
        remindedAt: null,
        viewCount: 0,
        expiresAt: { gt: now, lt: new Date(now.getTime() + 2 * DAY_MS) },
        creator: { status: "ACTIVE" }
      },
      select: {
        id: true,
        folder: true,
        expiresAt: true,
        eventId: true,
        event: { select: { eventName: true, companyName: true } },
        // role decides who gets chased; a photographer's link is not theirs to chase.
        creator: { select: { id: true, name: true, email: true, role: true } }
      }
    });
  } catch {
    expiring = [];
  }

  /* A photographer can create a client link now, and can therefore be a link's
     creator — but this is an internal email. It lists other people's links,
     tells the reader to open the ERP, and is addressed to staff. Sending it to
     a third party leaks what we are doing for other clients.

     So a photographer's link is chased by the employee who put them on that
     event: PhotographerEventAccess.grantedById, the person who owns the
     decision and can act on it. The email names the photographer so it is
     obvious whose link it is. Employee-created links are untouched. */
  type Recipient = { name: string; email: string };
  const byPhotographer = expiring.filter((s) => s.creator.role === "PHOTOGRAPHER");
  const grantors = new Map<string, Recipient>(); // keyed `${photographerId}:${eventId}`

  if (byPhotographer.length > 0) {
    try {
      const grants = await prisma.photographerEventAccess.findMany({
        // One query for every pair rather than one per share.
        where: {
          OR: byPhotographer.map((s) => ({ photographerId: s.creator.id, eventId: s.eventId })),
          // A revoked grant is not a live relationship: the grantor is no longer on the
          // event, so it must not supply the recipient for that photographer's link.
          revokedAt: null,
          // The recipient has to be here to act on it, like every other branch below.
          grantedBy: { status: "ACTIVE" }
        },
        select: {
          photographerId: true,
          eventId: true,
          grantedBy: { select: { name: true, email: true } }
        }
      });
      for (const grant of grants) {
        grantors.set(`${grant.photographerId}:${grant.eventId}`, grant.grantedBy);
      }
    } catch {
      /* Left empty on purpose: every photographer-created link is then skipped
         below without being stamped, so the next run tries again. */
    }
  }

  type Item = { share: ExpiringShare; viaPhotographer: string | null };
  const byRecipient = new Map<string, { name: string; items: Item[] }>();

  for (const share of expiring) {
    let recipient: Recipient;
    let viaPhotographer: string | null = null;

    if (share.creator.role === "PHOTOGRAPHER") {
      const grantor = grantors.get(`${share.creator.id}:${share.eventId}`);
      /* No active grantor — they have left, or the grant predates this. Nobody
         internal owns the link, and the photographer must not be told, so skip
         it. Because remindedAt is only stamped for links an email went out for,
         skipping leaves it to be picked up whenever someone does own it. */
      if (!grantor) continue;
      recipient = grantor;
      viaPhotographer = share.creator.name;
    } else {
      recipient = { name: share.creator.name, email: share.creator.email };
    }

    const entry = byRecipient.get(recipient.email);
    if (entry) entry.items.push({ share, viaPhotographer });
    else byRecipient.set(recipient.email, { name: recipient.name, items: [{ share, viaPhotographer }] });
  }

  /* remindedAt is what stops a share being chased again, so only stamp the ones an
     email actually went out for.

     Note the gap this leaves: the query above drops shares whose creator is no longer
     ACTIVE, so such a share is chased by nobody — no email goes anywhere, and the link
     expires unopened with no one told. That is the behaviour today, not a deferral.
     Re-routing an orphaned share to the creator's manager (or the event owner) is a
     deliberate open question, not something handled below. */
  const remindedIds: string[] = [];

  for (const [email, { name, items }] of byRecipient) {
    /* "a gallery link you shared" is only true of the reader's own links. When
       a photographer's link is in the batch the wording has to widen; the row
       below says who actually created it. */
    const anyFromPhotographer = items.some((i) => i.viaPhotographer !== null);
    const ok = await sendReminderEmail(
      email,
      `${items.length} client link${items.length !== 1 ? "s" : ""} expiring unopened`,
      "Client links expiring",
      anyFromPhotographer
        ? `${name}, ${items.length === 1 ? "a client gallery link has" : "these client gallery links have"} not been opened yet and will expire within 48 hours.`
        : `${name}, ${items.length === 1 ? "a gallery link you shared has" : "these gallery links have"} not been opened yet and will expire within 48 hours.`,
      items.map(({ share: s, viaPhotographer }) =>
        reminderRow(
          `${s.event.eventName} — ${s.event.companyName}`,
          `${s.folder ? `Folder: ${s.folder} · ` : ""}Expires ${fmt(s.expiresAt)} · never opened${
            viaPhotographer ? ` · created by photographer ${viaPhotographer}` : ""
          }`
        )
      ),
      "Open the event in the ERP to issue a fresh link, or check the client received the original."
    );
    if (ok) {
      sent.push(`links:${email}`);
      remindedIds.push(...items.map((i) => i.share.id));
    }
  }

  if (remindedIds.length > 0) {
    await prisma.mediaShare
      .updateMany({ where: { id: { in: remindedIds } }, data: { remindedAt: now } })
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
      assignedTo: { not: null },
      assignedToUser: { status: "ACTIVE" }
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
      teamMembers: {
        where: { user: { status: "ACTIVE" } },
        select: { user: { select: { name: true, email: true } } }
      }
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

  /* 5 — housekeeping, not a reminder: multipart uploads whose browser tab was
         simply closed. Left alone they keep their parts in the bucket and, for
         a photographer, keep their bytes counted against the 1 TB ceiling
         forever. This is the only daily job there is, so it rides along here.

         Sealed in its own try/catch: storage being unreachable must not stop
         the emails above from having gone out, or the ones below — there are
         none below today, but the ordering should not be load-bearing. */
  let swept: { swept: number; bytesReleased: number } | null = null;
  try {
    swept = await sweepAbandonedMultipart();
  } catch {
    swept = null;
  }

  return Response.json({
    ranAt: now.toISOString(),
    emails: sent.length,
    breakdown: {
      expiringLinks: expiring.length,
      pendingClaims: pendingClaims.length,
      closingDeals: closing.length,
      eventsMissingMedia: staleEvents.length
    },
    // null means the sweep threw; the counts are absent rather than zero.
    abandonedUploads: swept
  });
}

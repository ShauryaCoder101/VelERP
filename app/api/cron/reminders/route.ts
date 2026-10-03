import { prisma } from "../../../../lib/db";
import { sendReminderEmail, reminderRow, sendUploadAlertEmail } from "../../../../lib/email";
import { sweepAbandonedMultipart } from "../../../../lib/multipart-janitor";
import { sweepCharges, type SweepResult } from "../../../../lib/upload-charges";
import { computeUploadHealth, unhealthyAccounts, healthHint } from "../../../../lib/upload-health";

/* Runs on a Vercel cron. The route is publicly addressable, so it refuses
   anything without the shared secret — otherwise a stranger could make the
   system mail your staff, repeatedly.

   Everything here is read-only apart from stamping remindedAt, which is what
   stops the same link being chased every single day. */

export const maxDuration = 60;

const DAY_MS = 86_400_000;
const fmt = (d: Date) =>
  d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

/* Vercel runs this in UTC, so the timezone has to be named explicitly rather
   than left to the runtime's locale — otherwise "last failure 04:12" in an
   Indian inbox is five and a half hours off and reads as the middle of the
   night. */
const istTime = (d: Date) =>
  d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit"
  });

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

  /* 5 — uploads that are failing. Not a reminder about something somebody
         forgot: an alarm about something the ERP broke.

         On 1 October one bug made every file over 16MB fail at the final step.
         A firm's browser aborted ~290 videos four or five times over while 396
         smaller files from the same folder saved perfectly, and nothing here
         said a word — the file count went up, the quota bar went up, and that is
         exactly what a good day looks like. Velocity heard about it two days
         later, from the firm, in a voice note.

         Deliberately placed BEFORE the two sweeps below. Those can spend 25 of
         this route's 60 seconds; the alert is the one thing in this file that is
         urgent, so it must not be what gets cut off when storage is slow. It
         costs three aggregate queries and at most a handful of emails.

         Its own try/catch, like everything else here: a failure to warn about
         broken uploads must not also break the reminders. */
  type AlertSummary = {
    accountsChecked: number;
    accountsAffected: number;
    recipients: number;
  };
  let uploadAlert: AlertSummary | null = null;
  try {
    const health = await computeUploadHealth({ since: new Date(now.getTime() - DAY_MS) });
    const affected = unhealthyAccounts(health);

    let recipients = 0;
    if (affected.length > 0) {
      /* Whoever can actually act: chase the firm, or get the bug looked at.
         UPLOAD_ALERT_EMAILS exists so an on-call address can be added without a
         role change — comma separated, trimmed, blanks dropped. */
      const leads = await prisma.user.findMany({
        where: { status: "ACTIVE", role: { in: ["MANAGING_DIRECTOR", "HEAD_OF_OPERATIONS"] } },
        select: { name: true, email: true }
      });
      const extra = (process.env.UPLOAD_ALERT_EMAILS ?? "")
        .split(",")
        .map((address) => address.trim())
        .filter(Boolean)
        .map((email) => ({ name: "Team", email }));

      // One mail per address: a lead who is also listed in the env var must not
      // get two copies of the same alarm.
      const byAddress = new Map<string, { name: string; email: string }>();
      for (const person of [...leads, ...extra]) {
        if (!byAddress.has(person.email)) byAddress.set(person.email, person);
      }

      /* An alarm correctly raised and sent to nobody is the 1 October shape all
         over again — the only trace would be `recipients: 0` in this route's JSON
         response, which nobody reads on a day nothing looks wrong. Deactivate the
         Head of Operations, change the MD's role, never set UPLOAD_ALERT_EMAILS,
         and that is exactly what happens, so it is said out loud in the logs. */
      if (byAddress.size === 0) {
        console.error(
          `[upload-alert] NO RECIPIENTS: ${affected.length} account(s) failing uploads and nobody to tell — ` +
            "no ACTIVE MANAGING_DIRECTOR or HEAD_OF_OPERATIONS, and UPLOAD_ALERT_EMAILS is unset"
        );
      }

      const rows = affected.map((account) => {
        const gb = account.failedBytes / 1024 ** 3;
        const parts = [
          account.uid ? `UID ${account.uid}` : "employee",
          account.largeFailed > 0
            ? `${account.largeFailed} of ${account.largeAttempted} large file${
                account.largeAttempted !== 1 ? "s" : ""
              } failed${gb >= 0.01 ? ` (${gb.toFixed(gb >= 10 ? 0 : 1)} GB)` : ""}`
            : null,
          account.smallMissing > 0
            ? `${account.smallMissing} small file${
                account.smallMissing !== 1 ? "s" : ""
              } never arrived`
            : null,
          `${account.filesRegistered} file${account.filesRegistered !== 1 ? "s" : ""} did save`,
          // IST, because that is the clock everyone reading this is on, and a
          // UTC timestamp in an Indian inbox is a five-and-a-half-hour mistake
          // waiting to happen.
          account.lastFailureAt ? `last failure ${istTime(account.lastFailureAt)} IST` : null
        ].filter(Boolean);

        return {
          who: account.name,
          detail: parts.join(" · "),
          hint: healthHint(account)
        };
      });

      for (const person of byAddress.values()) {
        const ok = await sendUploadAlertEmail({
          to: person.email,
          recipientName: person.name,
          windowLabel: "the last 24 hours",
          rows,
          footer: appUrl
            ? `Per-firm figures: ${appUrl}/photographers`
            : "Open the photographer panel in the ERP for the per-firm figures."
        });
        if (ok) {
          sent.push(`uploads:${person.email}`);
          recipients += 1;
        }
      }
    }

    uploadAlert = {
      accountsChecked: health.accounts.length,
      accountsAffected: affected.length,
      recipients
    };
  } catch (error: any) {
    // Logged, not swallowed silently: a health check that stopped working is the
    // same failure mode as having no health check at all.
    console.error(
      `[cron/reminders] upload health check failed: ${(error as Error)?.name ?? "Error"}: ${
        error?.message ?? error
      }`
    );
    uploadAlert = null;
  }

  /* 6 — housekeeping, not a reminder: multipart uploads whose browser tab was
         simply closed. Left alone they keep their parts in the bucket and, for
         a photographer, keep their bytes counted against the 1 TB ceiling
         forever. This is the only daily cron there is, so housekeeping rides
         along here.

         Sealed in its own try/catch: storage being unreachable must not stop
         the emails above from having gone out, or the ones below — there are
         none below today, but the ordering should not be load-bearing. */
  let swept: { swept: number; bytesReleased: number } | null = null;
  try {
    swept = await sweepAbandonedMultipart();
  } catch {
    swept = null;
  }

  /* 7 — the other half of the same housekeeping: single-PUT originals and
         thumb/preview slots that were charged at presign and never written.
         Every firm, a larger budget than the opportunistic sweep presign runs
         (that one is on an uploader's critical path; this one is not), and its
         own try/catch for the same reason as above.

         Both budgets are sized against this route's maxDuration of 60 seconds,
         pessimistically — a storage round trip at 250 ms, which is roughly the
         worst R2 has shown us for a HEAD or an abort and about five times the
         typical figure:

           janitor (500 rows, 20 aborts at a time)
             25 waves x 250 ms                            =  6.3 s
             5 claim transactions x 3 statements x ~80 ms =  1.2 s
           charges (1000 rows, 20 HEADs at a time)
             50 waves x 250 ms                            = 12.5 s
             <= 20 settle transactions x 3 x ~80 ms       =  4.8 s
                                                            -------
                                                            24.8 s

         which leaves ~35 s for the emails and the health check above, and at the
         typical round trip the whole of section 6 and 7 is nearer 5 s. The health
         check in section 5 adds three aggregate queries and one small SELECT, so
         well under a second; it runs first precisely so these two cannot eat its
         budget.

         Note that the second line of each pair counts STATEMENTS, not
         transactions. It has to: Prisma's interactive transactions time out
         after 5000 ms, so what must fit in that budget is the round trips inside
         one claim, and a batch spanning sixty firms used to issue one refund
         statement per firm — sixty-one sequential round trips, ~4.9 s, i.e. a
         P2028 the sweeps swallowed as "refunded: 0" while re-selecting the same
         oldest rows on every later run. Each claim is now three statements
         whatever the batch size (claim, lock in order, refund), which is what
         makes both the per-transaction budget and the figures above hold.

         Running out of budget still only means the rest is swept on the next
         pass — but the point of the numbers is that a flood's backlog has to
         drain faster than a flood can create it. */
  let charges: SweepResult | null = null;
  try {
    charges = await sweepCharges({ limit: 1000 });
  } catch {
    charges = null;
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
    abandonedUploads: swept,
    uploadCharges: charges,
    // Same convention: null means the health check itself threw, which is a
    // different thing from "nothing is failing".
    uploadHealth: uploadAlert
  });
}

import nodemailer from "nodemailer";

let transporter: nodemailer.Transporter | null = null;

function getTransporter() {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || "587");
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) return null;

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });

  return transporter;
}

/* Reminder mail shares one plain, document-ish shell — these land in inboxes
   next to real correspondence, so they read as a note rather than a campaign. */
const frame = (heading: string, intro: string, content: string, footer?: string) => `
  <div style="font-family:Georgia,'Times New Roman',serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#24242a">
    <div style="border-bottom:1px solid #e7e7ea;padding-bottom:14px;margin-bottom:20px">
      <span style="font-family:system-ui,sans-serif;font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#9a9aa3">Velocity ERP</span>
      <h1 style="margin:6px 0 0;font-size:21px;color:#0f0f12">${heading}</h1>
      <div style="width:52px;height:2px;background:#ed3039;margin-top:12px"></div>
    </div>
    <p style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.55;color:#5c5c66;margin:0 0 18px">${intro}</p>
    ${content}
    ${footer ? `<p style="font-family:system-ui,sans-serif;font-size:12px;color:#9a9aa3;margin:20px 0 0">${footer}</p>` : ""}
  </div>
`;

const shell = (heading: string, intro: string, rows: string[], footer?: string) =>
  frame(
    heading,
    intro,
    `<table style="width:100%;border-collapse:collapse;font-family:system-ui,sans-serif;font-size:13.5px">${rows.join("")}</table>`,
    footer
  );

export const reminderRow = (main: string, meta: string) => `
  <tr>
    <td style="padding:10px 0;border-bottom:1px solid #e7e7ea">
      <strong style="color:#0f0f12">${main}</strong><br>
      <span style="color:#82828c;font-size:12.5px">${meta}</span>
    </td>
  </tr>
`;

/* Never throws. A reminder run touches many recipients, and one bad address or
   a rejected login must not stop the rest of the batch going out. */
export async function sendReminderEmail(to: string, subject: string, heading: string, intro: string, rows: string[], footer?: string) {
  const t = getTransporter();
  if (!t) {
    console.warn(`SMTP not configured — would email ${to}: ${subject} (${rows.length} items)`);
    return false;
  }
  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      html: shell(heading, intro, rows, footer)
    });
    return true;
  } catch (error: any) {
    console.error(`reminder email to ${to} failed: ${error?.message ?? error}`);
    return false;
  }
}

/* Sent the moment a task is assigned, so it does not wait for the next daily
   digest. Like the reminders, it never throws — a task must still be created if
   the mail server is having a bad day. */
export async function sendTaskAssignedEmail(opts: {
  to: string;
  assigneeName: string;
  assignerName: string;
  title: string;
  notes?: string | null;
  dueDate?: Date | null;
}) {
  const t = getTransporter();
  if (!t) {
    console.warn(`SMTP not configured — would notify ${opts.to} of task "${opts.title}"`);
    return false;
  }

  const due = opts.dueDate
    ? opts.dueDate.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
    : null;

  const rows = [
    reminderRow(opts.title, `Assigned by ${opts.assignerName}${due ? ` · due ${due}` : ""}`)
  ];
  if (opts.notes) rows.push(reminderRow("Notes", opts.notes));

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;

  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: opts.to,
      subject: `New task: ${opts.title}`,
      html: shell(
        "A task has been assigned to you",
        `${opts.assigneeName}, ${opts.assignerName} has assigned you the following.`,
        rows,
        appUrl ? `See it in the ERP: ${appUrl}` : undefined
      )
    });
    return true;
  } catch (error: any) {
    console.error(`task email to ${opts.to} failed: ${error?.message ?? error}`);
    return false;
  }
}

/* Sent to whoever is uploading, at the start and end of a batch.
   A 300GB dump runs for hours; the point is that they can close the laptop lid
   on the way home and still find out whether it landed. */
export async function sendUploadEmail(opts: {
  to: string;
  name: string;
  eventName: string;
  phase: "start" | "end";
  fileCount: number;
  totalBytes: number;
  failed?: number;
}) {
  const t = getTransporter();
  if (!t) {
    console.warn(`SMTP not configured — would notify ${opts.to} of upload ${opts.phase}`);
    return false;
  }

  const gb = opts.totalBytes / 1024 ** 3;
  const size = gb >= 1 ? `${gb.toFixed(2)} GB` : `${(opts.totalBytes / 1024 ** 2).toFixed(0)} MB`;
  const files = `${opts.fileCount} file${opts.fileCount !== 1 ? "s" : ""}`;
  const failed = opts.failed ?? 0;

  const starting = opts.phase === "start";
  const heading = starting ? "Upload started" : failed > 0 ? "Upload finished with errors" : "Upload finished";
  const subject = starting
    ? `Upload started — ${opts.eventName}`
    : failed > 0
      ? `Upload finished with ${failed} failure${failed !== 1 ? "s" : ""} — ${opts.eventName}`
      : `Upload finished — ${opts.eventName}`;

  const rows = [reminderRow(opts.eventName, `${files} · ${size}`)];
  if (!starting) {
    rows.push(
      reminderRow(
        failed > 0 ? `${opts.fileCount - failed} uploaded, ${failed} failed` : "All files uploaded",
        failed > 0 ? "Reopen the upload dialog and press Upload again to retry the failures." : "Nothing further to do."
      )
    );
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;

  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: opts.to,
      subject,
      html: shell(
        heading,
        starting
          ? `${opts.name}, your upload is under way. You will get another note when it finishes — you can close the tab once every file shows a progress bar.`
          : `${opts.name}, your upload has finished.`,
        rows,
        appUrl ? `Event media: ${appUrl}/events` : undefined
      )
    });
    return true;
  } catch (error: any) {
    console.error(`upload email to ${opts.to} failed: ${error?.message ?? error}`);
    return false;
  }
}

export async function sendOtpEmail(to: string, otp: string) {
  const t = getTransporter();
  if (!t) {
    console.warn("SMTP not configured — OTP for", to, "is", otp);
    return;
  }

  await t.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: "Your Velocity ERP password reset code",
    html: frame(
      "Password reset",
      "Enter this code on the reset screen to choose a new password. It expires in 10 minutes.",
      `<div style="border:1px solid #e7e7ea;border-radius:6px;padding:22px;text-align:center;background:#fafafa">
         <span style="font-family:ui-monospace,'IBM Plex Mono',Menlo,monospace;font-size:30px;letter-spacing:10px;font-weight:500;color:#0f0f12">${otp}</span>
       </div>`,
      "If you didn't ask for this, ignore this email — nothing has changed on your account."
    )
  });
}

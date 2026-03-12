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

export async function sendOtpEmail(to: string, otp: string) {
  const t = getTransporter();
  if (!t) {
    console.warn("SMTP not configured — OTP for", to, "is", otp);
    return;
  }

  await t.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: "Velocity ERP — Password Reset OTP",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
        <h2 style="margin:0 0 8px">Password Reset</h2>
        <p style="color:#555">Use this OTP to reset your Velocity ERP password. It expires in 10 minutes.</p>
        <div style="background:#f5f5f5;border-radius:12px;padding:24px;text-align:center;margin:24px 0">
          <span style="font-size:32px;letter-spacing:8px;font-weight:700">${otp}</span>
        </div>
        <p style="color:#999;font-size:13px">If you didn't request this, you can safely ignore this email.</p>
      </div>
    `
  });
}

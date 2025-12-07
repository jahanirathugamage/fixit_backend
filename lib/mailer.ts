// lib/mailer.ts
import nodemailer from "nodemailer";

const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;

export const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: smtpUser,
    pass: smtpPass,
  },
});

export async function sendEmail(
  to: string,
  subject: string,
  text: string,
): Promise<void> {
  if (!smtpUser || !smtpPass) {
    console.warn("sendEmail called but SMTP config is missing.");
    return;
  }

  console.log("Sending email to:", to, "subject:", subject);

  await transporter.sendMail({
    from: `"FixIt Admin" <${smtpUser}>`,
    to,
    subject,
    text,
  });

  console.log("Email sent to:", to);
}

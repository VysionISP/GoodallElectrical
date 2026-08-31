import nodemailer from "nodemailer";

export interface SmtpCredentials {
  host: string;
  port: string; // stored as string since all integration credentials are Record<string,string>
  secure?: string; // "true" | "false"
  user: string;
  pass: string;
  fromEmail: string;
  fromName?: string;
}

function buildTransport(creds: SmtpCredentials) {
  return nodemailer.createTransport({
    host: creds.host,
    port: Number(creds.port) || 587,
    secure: creds.secure === "true",
    auth: { user: creds.user, pass: creds.pass },
  });
}

export async function testSmtpConnection(creds: SmtpCredentials): Promise<{ ok: true; detail?: string }> {
  const transport = buildTransport(creds);
  await transport.verify();
  return { ok: true, detail: `Connected to ${creds.host}:${creds.port}.` };
}

export async function sendEmail(
  creds: SmtpCredentials,
  params: { to: string; subject: string; body: string }
): Promise<{ messageId: string }> {
  const transport = buildTransport(creds);
  const from = creds.fromName ? `"${creds.fromName}" <${creds.fromEmail}>` : creds.fromEmail;
  const info = await transport.sendMail({
    from,
    to: params.to,
    subject: params.subject,
    text: params.body,
  });
  return { messageId: info.messageId };
}

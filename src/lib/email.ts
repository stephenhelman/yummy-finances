import { Resend } from "resend";
import { requireEnv } from "@/lib/env";

export type OutgoingEmail = {
  to: string | string[];
  cc?: string | string[];
  subject: string;
  html: string;
  text?: string;
  attachments?: { filename: string; content: Buffer }[];
};

/** Sends via Resend and returns the message id. Throws on API error. */
export async function sendEmail(msg: OutgoingEmail): Promise<string> {
  const resend = new Resend(requireEnv("RESEND_API_KEY"));
  const { data, error } = await resend.emails.send({
    from: requireEnv("EMAIL_FROM"),
    to: msg.to,
    cc: msg.cc,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
    attachments: msg.attachments,
  });
  if (error || !data) throw new Error(`Resend error: ${error?.message ?? "no data"}`);
  return data.id;
}

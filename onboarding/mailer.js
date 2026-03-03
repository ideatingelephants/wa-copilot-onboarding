import nodemailer from "nodemailer";
import { onboardingConfig } from "./config.js";

function isMailConfigured() {
  return Boolean(onboardingConfig.smtpHost && onboardingConfig.smtpFrom);
}

function createTransport() {
  return nodemailer.createTransport({
    host: onboardingConfig.smtpHost,
    port: onboardingConfig.smtpPort,
    secure: onboardingConfig.smtpSecure,
    auth:
      onboardingConfig.smtpUser || onboardingConfig.smtpPass
        ? {
            user: onboardingConfig.smtpUser,
            pass: onboardingConfig.smtpPass
          }
        : undefined
  });
}

function setupEmailSubject(projectId) {
  return `WA Copilot setup ready (${projectId})`;
}

function setupEmailText(input) {
  const lines = [];
  lines.push("Your WhatsApp Copilot workspace has been provisioned.");
  lines.push("");
  lines.push(`Project ID: ${input.projectId}`);
  lines.push(`Zone: ${input.zone}`);
  lines.push(`VM: ${input.instanceName}`);
  lines.push(`External IP: ${input.externalIp || "(pending)"}`);
  lines.push("");
  lines.push("Next steps:");
  lines.push("1. Open the VM logs link and wait for bot start.");
  lines.push("2. Scan QR from the bot WhatsApp phone.");
  lines.push("3. Add bot to your groups.");
  lines.push("4. Send /watch in each target group.");
  lines.push("");
  lines.push(`Logs link: ${input.logsUrl}`);
  lines.push(`SSH command: ${input.sshCommand}`);
  lines.push("");
  lines.push("Note: QR image cannot be attached directly in this flow; use the logs link to pair.");
  if (input.initialContext) {
    lines.push("");
    lines.push(`Initial context saved: ${input.initialContext}`);
  }
  return lines.join("\n");
}

export async function sendSetupEmailIfConfigured({ toEmail, result, initialContext }) {
  if (!toEmail || !isMailConfigured()) {
    return { sent: false, reason: "not_configured_or_no_recipient" };
  }

  const transport = createTransport();
  const logsUrl =
    result?.setupInstructions?.find((line) => line.startsWith("Open serial logs: "))?.replace("Open serial logs: ", "") || "";
  const sshCommand =
    result?.setupInstructions?.find((line) => line.startsWith("SSH command: "))?.replace("SSH command: ", "") || "";

  await transport.sendMail({
    from: onboardingConfig.smtpFrom,
    to: toEmail,
    subject: setupEmailSubject(result.projectId),
    text: setupEmailText({
      projectId: result.projectId,
      zone: result.zone,
      instanceName: result.instanceName,
      externalIp: result.externalIp,
      logsUrl,
      sshCommand,
      initialContext
    })
  });

  return { sent: true };
}

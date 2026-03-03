import dotenv from "dotenv";

dotenv.config();

function env(name, fallback = "") {
  const value = process.env[name];
  if (typeof value !== "string") {
    return fallback;
  }
  return value.trim() || fallback;
}

function envInt(name, fallback) {
  const raw = env(name, String(fallback));
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name, fallback) {
  const raw = env(name, "");
  if (!raw) {
    return fallback;
  }
  return ["1", "true", "yes", "on", "y"].includes(raw.toLowerCase());
}

function parseAllowedDomains() {
  const raw = env("ONBOARDING_ALLOWED_EMAIL_DOMAINS", "");
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

export const onboardingConfig = {
  port: envInt("ONBOARDING_PORT", 8787),
  baseUrl: env("ONBOARDING_BASE_URL", "http://localhost:8787"),
  googleClientId: env("GOOGLE_OAUTH_CLIENT_ID", ""),
  googleClientSecret: env("GOOGLE_OAUTH_CLIENT_SECRET", ""),
  sessionTtlHours: envInt("ONBOARDING_SESSION_TTL_HOURS", 2),
  allowedDomains: parseAllowedDomains(),
  autoLogoutAfterProvision: envBool("AUTO_LOGOUT_AFTER_PROVISION", true),
  defaultZone: env("BOOTSTRAP_DEFAULT_ZONE", "asia-south2-a"),
  defaultRegion: env("BOOTSTRAP_DEFAULT_REGION", "asia-south2"),
  defaultTimezone: env("BOOTSTRAP_DEFAULT_TIMEZONE", "Asia/Kolkata"),
  bootstrapRepoUrl: env("BOOTSTRAP_REPO_URL", ""),
  bootstrapRepoBranch: env("BOOTSTRAP_REPO_BRANCH", "main"),
  billingSetupUrl: env("ONBOARDING_BILLING_SETUP_URL", "https://console.cloud.google.com/billing/create"),
  smtpHost: env("SMTP_HOST", ""),
  smtpPort: envInt("SMTP_PORT", 587),
  smtpSecure: envBool("SMTP_SECURE", false),
  smtpUser: env("SMTP_USER", ""),
  smtpPass: env("SMTP_PASS", ""),
  smtpFrom: env("SMTP_FROM", "")
};

export function assertOnboardingConfig() {
  if (!onboardingConfig.googleClientId || !onboardingConfig.googleClientSecret) {
    throw new Error("Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET before starting onboarding server.");
  }
  if (!onboardingConfig.bootstrapRepoUrl) {
    throw new Error("Set BOOTSTRAP_REPO_URL to a public Git repo URL before provisioning.");
  }
}

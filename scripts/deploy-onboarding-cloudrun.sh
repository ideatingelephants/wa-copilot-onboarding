#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value core/project 2>/dev/null || true)}"
SERVICE_NAME="${SERVICE_NAME:-wa-copilot-onboarding}"
REGION="${REGION:-asia-south2}"

GOOGLE_OAUTH_CLIENT_ID="${GOOGLE_OAUTH_CLIENT_ID:-}"
GOOGLE_OAUTH_CLIENT_SECRET="${GOOGLE_OAUTH_CLIENT_SECRET:-}"
BOOTSTRAP_REPO_URL="${BOOTSTRAP_REPO_URL:-}"
BOOTSTRAP_REPO_BRANCH="${BOOTSTRAP_REPO_BRANCH:-main}"
ONBOARDING_BASE_URL="${ONBOARDING_BASE_URL:-https://placeholder.invalid}"
ONBOARDING_ALLOWED_EMAIL_DOMAINS="${ONBOARDING_ALLOWED_EMAIL_DOMAINS:-}"
ONBOARDING_BILLING_SETUP_URL="${ONBOARDING_BILLING_SETUP_URL:-https://console.cloud.google.com/billing/create}"
AUTO_LOGOUT_AFTER_PROVISION="${AUTO_LOGOUT_AFTER_PROVISION:-1}"
BOOTSTRAP_DEFAULT_ZONE="${BOOTSTRAP_DEFAULT_ZONE:-asia-south2-a}"
BOOTSTRAP_DEFAULT_REGION="${BOOTSTRAP_DEFAULT_REGION:-asia-south2}"
BOOTSTRAP_DEFAULT_TIMEZONE="${BOOTSTRAP_DEFAULT_TIMEZONE:-Asia/Kolkata}"

SMTP_HOST="${SMTP_HOST:-}"
SMTP_PORT="${SMTP_PORT:-587}"
SMTP_SECURE="${SMTP_SECURE:-0}"
SMTP_USER="${SMTP_USER:-}"
SMTP_PASS="${SMTP_PASS:-}"
SMTP_FROM="${SMTP_FROM:-}"

if [[ -z "${PROJECT_ID}" ]]; then
  echo "Missing PROJECT_ID and no default gcloud project is set."
  exit 1
fi
if [[ -z "${GOOGLE_OAUTH_CLIENT_ID}" ]]; then
  echo "Missing GOOGLE_OAUTH_CLIENT_ID"
  exit 1
fi
if [[ -z "${GOOGLE_OAUTH_CLIENT_SECRET}" ]]; then
  echo "Missing GOOGLE_OAUTH_CLIENT_SECRET"
  exit 1
fi
if [[ -z "${BOOTSTRAP_REPO_URL}" ]]; then
  echo "Missing BOOTSTRAP_REPO_URL (must be public https URL)"
  exit 1
fi

yaml_quote() {
  printf "%s" "$1" | sed "s/'/''/g"
}

TMP_ENV_FILE="$(mktemp)"
cleanup() {
  rm -f "${TMP_ENV_FILE}"
}
trap cleanup EXIT

{
  echo "GOOGLE_OAUTH_CLIENT_ID: '$(yaml_quote "${GOOGLE_OAUTH_CLIENT_ID}")'"
  echo "GOOGLE_OAUTH_CLIENT_SECRET: '$(yaml_quote "${GOOGLE_OAUTH_CLIENT_SECRET}")'"
  echo "ONBOARDING_PORT: '8080'"
  echo "ONBOARDING_BASE_URL: '$(yaml_quote "${ONBOARDING_BASE_URL}")'"
  echo "ONBOARDING_ALLOWED_EMAIL_DOMAINS: '$(yaml_quote "${ONBOARDING_ALLOWED_EMAIL_DOMAINS}")'"
  echo "ONBOARDING_BILLING_SETUP_URL: '$(yaml_quote "${ONBOARDING_BILLING_SETUP_URL}")'"
  echo "AUTO_LOGOUT_AFTER_PROVISION: '$(yaml_quote "${AUTO_LOGOUT_AFTER_PROVISION}")'"
  echo "BOOTSTRAP_REPO_URL: '$(yaml_quote "${BOOTSTRAP_REPO_URL}")'"
  echo "BOOTSTRAP_REPO_BRANCH: '$(yaml_quote "${BOOTSTRAP_REPO_BRANCH}")'"
  echo "BOOTSTRAP_DEFAULT_ZONE: '$(yaml_quote "${BOOTSTRAP_DEFAULT_ZONE}")'"
  echo "BOOTSTRAP_DEFAULT_REGION: '$(yaml_quote "${BOOTSTRAP_DEFAULT_REGION}")'"
  echo "BOOTSTRAP_DEFAULT_TIMEZONE: '$(yaml_quote "${BOOTSTRAP_DEFAULT_TIMEZONE}")'"
  echo "SMTP_HOST: '$(yaml_quote "${SMTP_HOST}")'"
  echo "SMTP_PORT: '$(yaml_quote "${SMTP_PORT}")'"
  echo "SMTP_SECURE: '$(yaml_quote "${SMTP_SECURE}")'"
  echo "SMTP_USER: '$(yaml_quote "${SMTP_USER}")'"
  echo "SMTP_PASS: '$(yaml_quote "${SMTP_PASS}")'"
  echo "SMTP_FROM: '$(yaml_quote "${SMTP_FROM}")'"
} >"${TMP_ENV_FILE}"

echo "Deploying ${SERVICE_NAME} to project ${PROJECT_ID} (${REGION})..."
gcloud run deploy "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --source . \
  --allow-unauthenticated \
  --quiet \
  --env-vars-file "${TMP_ENV_FILE}"

SERVICE_URL="$(gcloud run services describe "${SERVICE_NAME}" --project "${PROJECT_ID}" --region "${REGION}" --format='value(status.url)')"
echo "Service URL: ${SERVICE_URL}"

if [[ "${ONBOARDING_BASE_URL}" == "https://placeholder.invalid" ]]; then
  echo "Updating ONBOARDING_BASE_URL to service URL..."
  gcloud run services update "${SERVICE_NAME}" \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --quiet \
    --update-env-vars "ONBOARDING_BASE_URL=${SERVICE_URL}"
fi

echo ""
echo "Done."
echo "Share this link with users:"
echo "${SERVICE_URL}"
echo ""
echo "OAuth redirect URI must include:"
echo "${SERVICE_URL}/auth/google/callback"

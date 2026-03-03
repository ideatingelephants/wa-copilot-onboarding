import { OAuth2Client } from "google-auth-library";
import { onboardingConfig } from "./config.js";

const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/cloud-billing"
];

function redirectUri() {
  return `${onboardingConfig.baseUrl.replace(/\/+$/, "")}/auth/google/callback`;
}

export function newOAuthClient() {
  return new OAuth2Client(onboardingConfig.googleClientId, onboardingConfig.googleClientSecret, redirectUri());
}

export function buildGoogleAuthUrl(state) {
  const client = newOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    include_granted_scopes: true,
    prompt: "consent",
    scope: GOOGLE_SCOPES,
    state
  });
}

export async function exchangeCodeForTokens(code) {
  const client = newOAuthClient();
  const { tokens } = await client.getToken(code);
  return tokens;
}

export function hydratedOAuthClient(tokens, onTokenRefresh) {
  const client = newOAuthClient();
  client.setCredentials(tokens);
  if (typeof onTokenRefresh === "function") {
    client.on("tokens", (newTokens) => {
      onTokenRefresh(newTokens);
    });
  }
  return client;
}

export async function fetchUserInfo(accessToken) {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch user info (${response.status})`);
  }

  return response.json();
}

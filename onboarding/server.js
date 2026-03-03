import express from "express";
import { assertOnboardingConfig, onboardingConfig } from "./config.js";
import { listOpenBillingAccounts, provisionUserEnvironment } from "./gcp-provisioner.js";
import { sendSetupEmailIfConfigured } from "./mailer.js";
import { buildGoogleAuthUrl, exchangeCodeForTokens, fetchUserInfo, hydratedOAuthClient } from "./oauth.js";
import {
  cleanupExpired,
  clearSession,
  consumeAuthState,
  createAuthState,
  createSession,
  getSession,
  saveGoogleSession,
  saveSetupResult
} from "./session-store.js";

function parseCookies(header) {
  const source = String(header || "");
  const cookies = {};
  for (const item of source.split(";")) {
    const part = item.trim();
    if (!part || !part.includes("=")) {
      continue;
    }
    const index = part.indexOf("=");
    const key = part.slice(0, index).trim();
    const value = decodeURIComponent(part.slice(index + 1).trim());
    cookies[key] = value;
  }
  return cookies;
}

function cookieOptions(maxAgeSeconds, clear = false) {
  const options = [
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    clear ? "Max-Age=0" : `Max-Age=${maxAgeSeconds}`
  ];
  if (onboardingConfig.baseUrl.startsWith("https://")) {
    options.push("Secure");
  }
  return options.join("; ");
}

function setSessionCookie(res, sessionId, clear = false) {
  const maxAgeSeconds = Math.max(1, onboardingConfig.sessionTtlHours) * 60 * 60;
  res.setHeader("Set-Cookie", `wa_setup_sid=${encodeURIComponent(sessionId || "")}; ${cookieOptions(maxAgeSeconds, clear)}`);
}

function html(title, body, scripts = "") {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body { font-family: ui-sans-serif, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background: #f6f8fb; margin: 0; padding: 24px; color: #1b2430; }
    .wrap { max-width: 900px; margin: 0 auto; background: #ffffff; border: 1px solid #e7ebf2; border-radius: 12px; padding: 20px; }
    h1 { margin-top: 0; font-size: 24px; }
    p, li { line-height: 1.45; }
    .muted { color: #5d6b82; }
    .row { display: grid; grid-template-columns: 220px 1fr; gap: 10px; align-items: center; margin-bottom: 10px; }
    input, select, button { font-size: 14px; padding: 10px; border: 1px solid #cfd7e6; border-radius: 8px; }
    button { background: #1345aa; color: white; border-color: #1345aa; cursor: pointer; }
    button.secondary { background: #f0f4ff; color: #1345aa; }
    .actions { display: flex; gap: 10px; margin-top: 16px; }
    pre { white-space: pre-wrap; background: #f7f9fc; border: 1px solid #dde4f0; border-radius: 8px; padding: 12px; }
    .ok { color: #1f6f3d; }
    .err { color: #8f1d1d; }
    .hidden { display: none; }
    code { background: #f3f5f9; padding: 2px 4px; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="wrap">
    ${body}
  </div>
  ${scripts}
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function requiresAuth(req, res, next) {
  if (!req.session?.google?.tokens) {
    res.status(401).json({
      ok: false,
      error: "Not authenticated. Login again."
    });
    return;
  }
  next();
}

function getAuthClientForSession(session) {
  const tokens = session?.google?.tokens;
  if (!tokens) {
    throw new Error("No Google tokens found in session.");
  }
  return hydratedOAuthClient(tokens, (newTokens) => {
    session.google.tokens = { ...session.google.tokens, ...newTokens };
    session.updatedAtMs = Date.now();
  });
}

function sessionMiddleware(req, res, next) {
  cleanupExpired();
  const cookies = parseCookies(req.headers.cookie);
  let sid = cookies.wa_setup_sid || "";
  let session = getSession(sid);
  if (!session) {
    sid = createSession();
    session = getSession(sid);
    setSessionCookie(res, sid);
  }
  req.sessionId = sid;
  req.session = session;
  next();
}

function renderLanding() {
  return html(
    "WA Copilot GCP Setup",
    `<h1>WA Copilot Setup</h1>
<p class="muted">This creates a dedicated Google Cloud project for each user, links billing, enables required APIs, and boots one VM running the bot.</p>
<p><a href="/auth/google"><button>Sign in with Google</button></a></p>
<p class="muted">Your server does provisioning only during setup. Long-term billing and infrastructure stay in the user's own GCP account.</p>`
  );
}

function renderSetupPage(session) {
  const user = session.google;
  const last = session.setupResult;
  const userEmail = escapeHtml(user.email);
  const userName = escapeHtml(user.name || "");
  const lastSafe = last ? escapeHtml(JSON.stringify(last, null, 2)) : "";

  return html(
    "WA Copilot GCP Setup",
    `<h1>Provision Your GCP Workspace</h1>
<p>Signed in as <strong>${userEmail}</strong>${user.name ? ` (${userName})` : ""}</p>
<div class="actions">
  <a href="/"><button class="secondary" type="button">Refresh</button></a>
  <form method="post" action="/logout"><button class="secondary" type="submit">Logout</button></form>
</div>
<hr />
<div class="row">
  <label>Billing account</label>
  <div>
    <select id="billingSelect"><option value="">Loading billing accounts…</option></select>
    <div class="actions">
      <button id="loadBilling" class="secondary" type="button">Reload billing accounts</button>
      <input id="billingAccountId" placeholder="XXXXXX-XXXXXX-XXXXXX" />
    </div>
    <p class="muted" id="billingHint"></p>
  </div>
</div>
<div class="row"><label>Owner phone</label><input id="ownerPhone" placeholder="91xxxxxxxxxx" /></div>
<div class="row"><label>Bot phone (optional)</label><input id="botPhone" placeholder="91xxxxxxxxxx" /></div>
<div class="row"><label>Email for setup details</label><input id="contactEmail" value="${userEmail}" /></div>
<div class="row"><label>Initial context</label><input id="initialContext" placeholder="e.g. Track client deadlines and pending approvals." /></div>
<p class="muted">Defaults are automatic: timezone <code>${escapeHtml(onboardingConfig.defaultTimezone)}</code>, region <code>${escapeHtml(
      onboardingConfig.defaultRegion
    )}</code>, zone <code>${escapeHtml(onboardingConfig.defaultZone)}</code>, Gemini enabled.</p>
<div class="actions">
  <button id="provisionBtn" type="button">Provision workspace now</button>
</div>
<p class="muted">Provisioning can take 3-10 minutes.</p>
<pre id="output">Ready.</pre>
${
  last
    ? `<hr /><h3>Last Result</h3><pre>${lastSafe}</pre>`
    : ""
}`,
    `<script>
const output = document.getElementById("output");
const billingSelect = document.getElementById("billingSelect");
const billingInput = document.getElementById("billingAccountId");
const billingHint = document.getElementById("billingHint");

function setOutput(obj) {
  output.textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
}

async function loadBilling() {
  setOutput("Loading billing accounts...");
  const response = await fetch("/api/billing-accounts");
  const data = await response.json();
  if (!data.ok) {
    setOutput(data);
    return;
  }
  billingSelect.innerHTML = '<option value="">Select account</option>';
  for (const item of data.accounts) {
    const id = (item.name || "").replace("billingAccounts/", "");
    const option = document.createElement("option");
    option.value = id;
    option.textContent = id + " - " + (item.displayName || "");
    billingSelect.appendChild(option);
  }
  if (!data.accounts.length) {
    billingHint.innerHTML = 'No billing account found. <a target="_blank" rel="noreferrer" href="${escapeHtml(
      onboardingConfig.billingSetupUrl
    )}">Create one here</a>, then click reload.';
  } else {
    billingHint.textContent = "Pick one account or paste account id manually.";
    billingInput.value = (data.accounts[0].name || "").replace("billingAccounts/", "");
  }
  setOutput(data);
}

document.getElementById("loadBilling").addEventListener("click", loadBilling);
loadBilling();

billingSelect.addEventListener("change", () => {
  if (billingSelect.value) billingInput.value = billingSelect.value;
});

document.getElementById("provisionBtn").addEventListener("click", async () => {
  const payload = {
    displayName: "WA Copilot",
    projectId: "",
    billingAccountId: billingInput.value,
    ownerPhone: document.getElementById("ownerPhone").value,
    botPhone: document.getElementById("botPhone").value,
    contactEmail: document.getElementById("contactEmail").value,
    initialContext: document.getElementById("initialContext").value
  };
  setOutput("Provisioning started. Keep this tab open...");
  const response = await fetch("/api/provision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  setOutput(data);
  if (data.loggedOut) {
    alert("Setup complete. Session is now logged out for safety.");
  }
});
</script>`
  );
}

async function main() {
  assertOnboardingConfig();

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));
  app.use(sessionMiddleware);

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/", (req, res) => {
    if (!req.session?.google?.tokens) {
      res.status(200).send(renderLanding());
      return;
    }
    res.redirect("/setup");
  });

  app.get("/setup", (req, res) => {
    if (!req.session?.google?.tokens) {
      res.redirect("/");
      return;
    }
    res.status(200).send(renderSetupPage(req.session));
  });

  app.get("/auth/google", (req, res) => {
    const state = createAuthState(req.sessionId);
    const url = buildGoogleAuthUrl(state);
    res.redirect(url);
  });

  app.get("/auth/google/callback", async (req, res) => {
    const code = String(req.query.code || "");
    const state = String(req.query.state || "");
    const error = String(req.query.error || "");
    if (error) {
      res
        .status(400)
        .send(html("Auth Error", `<h1>Google auth error</h1><pre>${escapeHtml(error)}</pre><a href="/"><button>Back</button></a>`));
      return;
    }
    if (!code || !state) {
      res.status(400).send(html("Auth Error", "<h1>Missing code/state</h1>"));
      return;
    }

    try {
      const stateRecord = consumeAuthState(state);
      if (!stateRecord?.sessionId) {
        throw new Error("Invalid or expired auth state.");
      }

      const tokens = await exchangeCodeForTokens(code);
      const oauthClient = hydratedOAuthClient(tokens);
      const accessToken = await oauthClient.getAccessToken();
      const userInfo = await fetchUserInfo(typeof accessToken === "string" ? accessToken : accessToken?.token || "");

      const email = String(userInfo?.email || "").toLowerCase();
      if (!email) {
        throw new Error("Unable to read account email from Google.");
      }
      if (onboardingConfig.allowedDomains.length > 0) {
        const domain = email.split("@")[1] || "";
        if (!onboardingConfig.allowedDomains.includes(domain)) {
          throw new Error(`Email domain not allowed: ${domain}`);
        }
      }

      saveGoogleSession(stateRecord.sessionId, {
        email,
        name: userInfo?.name || "",
        picture: userInfo?.picture || "",
        tokens,
        loginAtMs: Date.now()
      });
      if (!getSession(stateRecord.sessionId)?.google?.tokens) {
        throw new Error("Session expired before auth could be saved. Try again.");
      }
      setSessionCookie(res, stateRecord.sessionId);
      res.redirect("/setup");
    } catch (authError) {
      res
        .status(400)
        .send(
          html(
            "Auth Error",
            `<h1>Google auth failed</h1><pre>${escapeHtml(String(authError?.message || authError))}</pre><a href="/"><button>Back</button></a>`
          )
        );
    }
  });

  app.post("/logout", (req, res) => {
    clearSession(req.sessionId);
    setSessionCookie(res, "", true);
    res.redirect("/");
  });

  app.get("/api/session", (req, res) => {
    const user = req.session?.google;
    res.json({
      ok: true,
      authenticated: Boolean(user?.tokens),
      email: user?.email || ""
    });
  });

  app.get("/api/billing-accounts", requiresAuth, async (req, res) => {
    try {
      const oauthClient = getAuthClientForSession(req.session);
      const accounts = await listOpenBillingAccounts(oauthClient);
      res.json({ ok: true, accounts });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: String(error?.message || error)
      });
    }
  });

  app.post("/api/provision", requiresAuth, async (req, res) => {
    const logs = [];
    const log = (line) => {
      logs.push(`[${new Date().toISOString()}] ${line}`);
    };

    try {
      const oauthClient = getAuthClientForSession(req.session);
      const result = await provisionUserEnvironment(oauthClient, req.body || {}, log);
      const emailOutcome = await sendSetupEmailIfConfigured({
        toEmail: String(req.body?.contactEmail || req.session?.google?.email || "").trim().toLowerCase(),
        result,
        initialContext: String(req.body?.initialContext || "").trim()
      }).catch((err) => ({
        sent: false,
        reason: `email_error:${String(err?.message || err)}`
      }));
      saveSetupResult(req.sessionId, {
        completedAtIso: new Date().toISOString(),
        result,
        logs,
        email: emailOutcome
      });

      const response = { ok: true, result, logs, email: emailOutcome, loggedOut: false };
      if (onboardingConfig.autoLogoutAfterProvision) {
        clearSession(req.sessionId);
        setSessionCookie(res, "", true);
        response.loggedOut = true;
      }

      res.json(response);
    } catch (error) {
      logs.push(`[${new Date().toISOString()}] ERROR: ${String(error?.message || error)}`);
      res.status(500).json({
        ok: false,
        error: String(error?.message || error),
        logs
      });
    }
  });

  app.listen(onboardingConfig.port, () => {
    console.log(`Onboarding server listening on ${onboardingConfig.baseUrl}`);
  });
}

main().catch((error) => {
  console.error("Fatal onboarding server error:", error);
  process.exit(1);
});

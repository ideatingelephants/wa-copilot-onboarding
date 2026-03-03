import crypto from "node:crypto";
import { onboardingConfig } from "./config.js";

const REQUIRED_APIS = [
  "compute.googleapis.com",
  "iam.googleapis.com",
  "serviceusage.googleapis.com",
  "cloudresourcemanager.googleapis.com",
  "cloudbilling.googleapis.com",
  "aiplatform.googleapis.com",
  "secretmanager.googleapis.com"
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomSuffix(size = 4) {
  return crypto.randomBytes(size).toString("hex").slice(0, size);
}

function asToken(value) {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value?.token === "string") {
    return value.token;
  }
  return "";
}

function slugify(value) {
  const raw = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return raw || "wa-copilot";
}

function normalizeProjectId(displayName, proposed) {
  const raw = String(proposed || "").trim().toLowerCase();
  const valid = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
  if (raw && valid.test(raw)) {
    return raw;
  }

  const base = slugify(displayName).replace(/[^a-z0-9-]/g, "").slice(0, 22);
  const safeBase = base && /^[a-z]/.test(base) ? base : `p-${base}`;
  const candidate = `${safeBase.slice(0, 24)}-${randomSuffix(4)}`.slice(0, 30).replace(/-+$/, "0");
  if (!valid.test(candidate)) {
    return `wa-${randomSuffix(8)}`;
  }
  return candidate;
}

function normalizeBillingAccountId(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    throw new Error("Billing account is required.");
  }
  if (raw.startsWith("billingAccounts/")) {
    return raw.split("/")[1];
  }
  return raw;
}

function normalizeOwnerPhone(value) {
  const digits = String(value || "").replace(/[^\d]/g, "");
  if (digits.length < 8 || digits.length > 15) {
    throw new Error("OWNER_PHONE must contain 8-15 digits.");
  }
  return digits;
}

function normalizeBotPhone(value) {
  const digits = String(value || "").replace(/[^\d]/g, "");
  if (!digits) {
    return "";
  }
  if (digits.length < 8 || digits.length > 15) {
    throw new Error("BOT_PHONE must contain 8-15 digits when provided.");
  }
  return digits;
}

function ensureZone(value) {
  const zone = String(value || "").trim();
  if (!zone) {
    return onboardingConfig.defaultZone;
  }
  if (!/^[a-z]+-[a-z0-9]+[0-9]-[a-z]$/.test(zone)) {
    throw new Error("Invalid GCP zone format.");
  }
  return zone;
}

function zoneToRegion(zone) {
  const parts = zone.split("-");
  if (parts.length < 3) {
    return onboardingConfig.defaultRegion;
  }
  return parts.slice(0, -1).join("-");
}

function normalizeRegion(value, fallback) {
  const raw = String(value || "").trim();
  const candidate = raw || fallback;
  if (!/^[a-z]+-[a-z0-9]+[0-9]$/.test(candidate)) {
    throw new Error("Invalid GCP region format.");
  }
  return candidate;
}

function normalizeGeminiModel(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "gemini-2.0-flash-001";
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(raw)) {
    throw new Error("Invalid Gemini model value.");
  }
  return raw;
}

function normalizeInitialContext(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

function escapeSqlLiteral(value) {
  return String(value).replace(/'/g, "''");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function serviceAccountMember(email) {
  return `serviceAccount:${email}`;
}

function parseJsonMaybe(text) {
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function buildStartupScript({
  repoUrl,
  repoBranch,
  ownerPhone,
  botPhone,
  initialContext,
  timezone,
  projectId,
  region,
  geminiModel,
  enableLLMClassifier
}) {
  const dbPassword = crypto.randomBytes(16).toString("hex");
  const dbPasswordSql = escapeSqlLiteral(dbPassword);
  const repoUrlSh = shellQuote(repoUrl);
  const repoBranchSh = shellQuote(repoBranch);

  const envLines = [
    `DATABASE_URL=postgres://wauser:${dbPassword}@127.0.0.1:5432/wa_ops_copilot`,
    `OWNER_PHONE=${ownerPhone}`,
    "OWNER_JID=",
    `BOT_PHONE=${botPhone || ""}`,
    `INITIAL_CONTEXT=${initialContext || ""}`,
    "AUTH_DIR=/opt/wa-copilot/auth",
    "LOG_LEVEL=info",
    `TIMEZONE=${timezone}`,
    `ENABLE_LLM_CLASSIFIER=${enableLLMClassifier ? "1" : "0"}`,
    "LLM_PROVIDER=gemini",
    `GCP_PROJECT_ID=${projectId}`,
    `GCP_LOCATION=${region}`,
    `GEMINI_MODEL=${geminiModel}`,
    "HIGH_PRIORITY_THRESHOLD=3.5",
    "CRITICAL_PRIORITY_THRESHOLD=6",
    "ANALYZE_INTERVAL_MS=60000",
    "NUDGE_INTERVAL_MS=120000",
    "DIGEST_INTERVAL_MINUTES=240"
  ];

  return `#!/bin/bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl git gnupg postgresql postgresql-contrib build-essential

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

id -u wa-bot >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash wa-bot
mkdir -p /opt/wa-copilot
cd /opt/wa-copilot

if [ ! -d repo/.git ]; then
  rm -rf repo
  git clone --depth 1 --branch ${repoBranchSh} ${repoUrlSh} repo
else
  cd repo
  git fetch origin ${repoBranchSh}
  git checkout ${repoBranchSh}
  git reset --hard FETCH_HEAD
  cd ..
fi

cd /opt/wa-copilot/repo
npm install --omit=dev

sudo -u postgres psql -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wauser') THEN
    CREATE ROLE wauser LOGIN PASSWORD '${dbPasswordSql}';
  ELSE
    ALTER ROLE wauser WITH PASSWORD '${dbPasswordSql}';
  END IF;
END
$$;
SQL

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'wa_ops_copilot'" | grep -q 1; then
  sudo -u postgres createdb -O wauser wa_ops_copilot
fi

cat > /opt/wa-copilot/repo/.env <<'ENVFILE'
${envLines.join("\n")}
ENVFILE

mkdir -p /opt/wa-copilot/auth
chown -R wa-bot:wa-bot /opt/wa-copilot

su -s /bin/bash wa-bot -c "cd /opt/wa-copilot/repo && npm run db:init"

cat > /etc/systemd/system/wa-copilot.service <<'UNIT'
[Unit]
Description=WhatsApp Group Ops Copilot
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=wa-bot
WorkingDirectory=/opt/wa-copilot/repo
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now wa-copilot.service
`;
}

async function authedRequest(oauthClient, method, url, body, expectedStatusCodes = [200]) {
  const token = asToken(await oauthClient.getAccessToken());
  if (!token) {
    throw new Error("Missing Google access token.");
  }

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await response.text();
  const payload = parseJsonMaybe(text);

  if (!expectedStatusCodes.includes(response.status)) {
    const message = payload?.error?.message || payload?.message || text || "Google API request failed.";
    const error = new Error(`${method} ${url} failed (${response.status}): ${message}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

async function waitForCloudResourceManagerOperation(oauthClient, name, timeoutMs = 300_000) {
  const start = Date.now();
  const opName = name.replace(/^\/+/, "");
  const url = `https://cloudresourcemanager.googleapis.com/v3/${opName}`;

  while (Date.now() - start < timeoutMs) {
    const op = await authedRequest(oauthClient, "GET", url);
    if (op.done) {
      if (op.error) {
        throw new Error(`Project operation failed: ${JSON.stringify(op.error)}`);
      }
      return op;
    }
    await sleep(3_000);
  }

  throw new Error(`Timed out waiting for operation ${name}`);
}

async function waitForServiceUsageOperation(oauthClient, name, timeoutMs = 300_000) {
  const start = Date.now();
  const opName = name.replace(/^\/+/, "");
  const url = `https://serviceusage.googleapis.com/v1/${opName}`;

  while (Date.now() - start < timeoutMs) {
    const op = await authedRequest(oauthClient, "GET", url);
    if (op.done) {
      if (op.error) {
        throw new Error(`Service enable failed: ${JSON.stringify(op.error)}`);
      }
      return op;
    }
    await sleep(3_000);
  }

  throw new Error(`Timed out waiting for service operation ${name}`);
}

async function waitForComputeZoneOperation(oauthClient, projectId, zone, operationName, timeoutMs = 600_000) {
  const start = Date.now();
  const name = operationName.replace(/^.*\//, "");
  const url = `https://compute.googleapis.com/compute/v1/projects/${projectId}/zones/${zone}/operations/${name}`;

  while (Date.now() - start < timeoutMs) {
    const op = await authedRequest(oauthClient, "GET", url);
    if (op.status === "DONE") {
      if (op.error) {
        throw new Error(`Compute operation failed: ${JSON.stringify(op.error)}`);
      }
      return op;
    }
    await sleep(4_000);
  }

  throw new Error(`Timed out waiting for compute operation ${operationName}`);
}

async function getProjectNumber(oauthClient, projectId) {
  const project = await authedRequest(oauthClient, "GET", `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}`);
  if (!project.projectNumber) {
    throw new Error("Unable to determine project number.");
  }
  return String(project.projectNumber);
}

async function addProjectRoleBinding(oauthClient, projectId, role, member) {
  const policy = await authedRequest(
    oauthClient,
    "POST",
    `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}:getIamPolicy`,
    {}
  );

  const bindings = Array.isArray(policy.bindings) ? policy.bindings : [];
  const target = bindings.find((item) => item.role === role);
  if (target) {
    const members = new Set(Array.isArray(target.members) ? target.members : []);
    members.add(member);
    target.members = Array.from(members).sort();
  } else {
    bindings.push({
      role,
      members: [member]
    });
  }

  await authedRequest(
    oauthClient,
    "POST",
    `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}:setIamPolicy`,
    {
      policy: {
        ...policy,
        bindings
      }
    }
  );
}

async function createOrGetServiceAccount(oauthClient, projectId, accountId, displayName) {
  const email = `${accountId}@${projectId}.iam.gserviceaccount.com`;
  const createUrl = `https://iam.googleapis.com/v1/projects/${projectId}/serviceAccounts`;

  try {
    const created = await authedRequest(
      oauthClient,
      "POST",
      createUrl,
      {
        accountId,
        serviceAccount: {
          displayName
        }
      },
      [200]
    );
    return created;
  } catch (error) {
    if (error.status !== 409) {
      throw error;
    }
    return authedRequest(
      oauthClient,
      "GET",
      `https://iam.googleapis.com/v1/projects/${projectId}/serviceAccounts/${encodeURIComponent(email)}`
    );
  }
}

async function listBillingAccountsInternal(oauthClient) {
  const response = await authedRequest(
    oauthClient,
    "GET",
    "https://cloudbilling.googleapis.com/v1/billingAccounts?filter=open%3Dtrue"
  );
  return Array.isArray(response.billingAccounts) ? response.billingAccounts : [];
}

export async function listOpenBillingAccounts(oauthClient) {
  const accounts = await listBillingAccountsInternal(oauthClient);
  return accounts.map((account) => ({
    name: account.name || "",
    displayName: account.displayName || "",
    open: Boolean(account.open)
  }));
}

export async function provisionUserEnvironment(oauthClient, input, eventLogger = () => {}) {
  const displayName = String(input.displayName || "WA Copilot Workspace").trim().slice(0, 30);
  const projectId = normalizeProjectId(displayName, input.projectId);
  const billingAccountId = normalizeBillingAccountId(input.billingAccountId);
  const ownerPhone = normalizeOwnerPhone(input.ownerPhone);
  const botPhone = normalizeBotPhone(input.botPhone);
  const initialContext = normalizeInitialContext(input.initialContext);
  const zone = ensureZone(onboardingConfig.defaultZone);
  const region = normalizeRegion(onboardingConfig.defaultRegion, zoneToRegion(zone));
  const timezone = onboardingConfig.defaultTimezone || "Asia/Kolkata";
  const geminiModel = normalizeGeminiModel("gemini-2.0-flash-001");
  const repoUrl = String(onboardingConfig.bootstrapRepoUrl).trim();
  const repoBranch = String(onboardingConfig.bootstrapRepoBranch).trim();
  const enableLLMClassifier = true;

  if (!repoUrl.startsWith("https://")) {
    throw new Error("BOOTSTRAP_REPO_URL must use https:// and be publicly accessible.");
  }

  eventLogger(`Creating project ${projectId}`);
  const createProjectOp = await authedRequest(
    oauthClient,
    "POST",
    "https://cloudresourcemanager.googleapis.com/v3/projects",
    {
      projectId,
      displayName
    }
  );

  await waitForCloudResourceManagerOperation(oauthClient, createProjectOp.name);
  eventLogger("Project created");

  const projectNumber = await getProjectNumber(oauthClient, projectId);
  eventLogger(`Project number: ${projectNumber}`);

  eventLogger(`Linking billing account ${billingAccountId}`);
  await authedRequest(
    oauthClient,
    "PUT",
    `https://cloudbilling.googleapis.com/v1/projects/${projectId}/billingInfo`,
    {
      billingAccountName: `billingAccounts/${billingAccountId}`,
      billingEnabled: true
    }
  );
  eventLogger("Billing linked");

  eventLogger("Enabling required APIs");
  const serviceEnableOp = await authedRequest(
    oauthClient,
    "POST",
    `https://serviceusage.googleapis.com/v1/projects/${projectNumber}/services:batchEnable`,
    {
      serviceIds: REQUIRED_APIS
    }
  );
  await waitForServiceUsageOperation(oauthClient, serviceEnableOp.name);
  eventLogger("APIs enabled");

  eventLogger("Creating runtime service account");
  const runtimeSa = await createOrGetServiceAccount(
    oauthClient,
    projectId,
    "wa-copilot-runtime",
    "WA Copilot Runtime"
  );
  const runtimeEmail = runtimeSa.email;

  eventLogger("Applying runtime IAM roles");
  const member = serviceAccountMember(runtimeEmail);
  for (const role of ["roles/aiplatform.user", "roles/secretmanager.secretAccessor", "roles/logging.logWriter"]) {
    await addProjectRoleBinding(oauthClient, projectId, role, member);
  }

  const instanceName = `wa-copilot-${randomSuffix(6)}`.slice(0, 62);
  const startupScript = buildStartupScript({
    repoUrl,
    repoBranch,
    ownerPhone,
    botPhone,
    initialContext,
    timezone,
    projectId,
    region,
    geminiModel,
    enableLLMClassifier
  });

  eventLogger(`Creating VM ${instanceName} in ${zone}`);
  const vmOp = await authedRequest(
    oauthClient,
    "POST",
    `https://compute.googleapis.com/compute/v1/projects/${projectId}/zones/${zone}/instances`,
    {
      name: instanceName,
      machineType: `zones/${zone}/machineTypes/e2-small`,
      disks: [
        {
          boot: true,
          autoDelete: true,
          initializeParams: {
            sourceImage: "projects/debian-cloud/global/images/family/debian-12",
            diskSizeGb: "20"
          }
        }
      ],
      networkInterfaces: [
        {
          network: "global/networks/default",
          accessConfigs: [
            {
              name: "External NAT",
              type: "ONE_TO_ONE_NAT",
              networkTier: "PREMIUM"
            }
          ]
        }
      ],
      serviceAccounts: [
        {
          email: runtimeEmail,
          scopes: ["https://www.googleapis.com/auth/cloud-platform"]
        }
      ],
      metadata: {
        items: [
          {
            key: "startup-script",
            value: startupScript
          }
        ]
      }
    }
  );
  await waitForComputeZoneOperation(oauthClient, projectId, zone, vmOp.name);
  eventLogger("VM created and startup script launched");

  const instance = await authedRequest(
    oauthClient,
    "GET",
    `https://compute.googleapis.com/compute/v1/projects/${projectId}/zones/${zone}/instances/${instanceName}`
  );
  const externalIp = instance?.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP || "";

  return {
    projectId,
    projectNumber,
    billingAccountId,
    zone,
    region,
    instanceName,
    externalIp,
    runtimeServiceAccount: runtimeEmail,
    setupInstructions: [
      "Wait 3-5 minutes for VM startup script to finish.",
      `Open serial logs: https://console.cloud.google.com/compute/instancesDetail/zones/${zone}/instances/${instanceName}?project=${projectId}&tab=logs`,
      `SSH command: gcloud compute ssh ${instanceName} --zone ${zone} --project ${projectId}`,
      "Once running, scan the WhatsApp QR from bot logs."
    ]
  };
}

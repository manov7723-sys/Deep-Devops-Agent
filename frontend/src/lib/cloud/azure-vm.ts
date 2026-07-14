/**
 * Azure VM provisioning over the ARM REST API — the TS port of the reference
 * app's `azure_connector.create_vm`. App-managed: uses the project's stored
 * Azure token (OAuth or service principal) — VM creation works fine over OAuth
 * even for personal accounts (unlike the AKS credential-fetch, which Azure
 * special-blocks). Creates the resource group, VNet+subnet, public IP, NIC and
 * the VM, polling each to "Succeeded" before using it as a dependency.
 *
 * Transport is Node's raw HTTPS client (not global fetch) to avoid Next.js's
 * fetch-patch mangling ARM writes.
 */
import { request as httpsRequest } from "node:https";
import { randomBytes } from "node:crypto";

const ARM = "management.azure.com";
const API_RESOURCES = "2021-04-01";
const API_NETWORK = "2023-09-01";
const API_COMPUTE = "2023-09-01";

/** Friendly OS name → Azure marketplace image reference. */
export const AZURE_VM_IMAGES: Record<
  string,
  { publisher: string; offer: string; sku: string; version: string }
> = {
  "ubuntu-22.04": {
    publisher: "Canonical",
    offer: "0001-com-ubuntu-server-jammy",
    sku: "22_04-lts-gen2",
    version: "latest",
  },
  "ubuntu-24.04": {
    publisher: "Canonical",
    offer: "ubuntu-24_04-lts",
    sku: "server-gen1",
    version: "latest",
  },
  "debian-12": { publisher: "Debian", offer: "debian-12", sku: "12-gen2", version: "latest" },
};

/** Azure-compliant password: ≥12 chars with upper, lower, digit, symbol. */
function generatePassword(): string {
  const U = "ABCDEFGHJKLMNPQRSTUVWXYZ",
    L = "abcdefghijkmnpqrstuvwxyz",
    D = "23456789",
    S = "!@#%^*-_";
  const all = U + L + D + S;
  const bytes = randomBytes(20);
  const pick = (set: string, i: number) => set[bytes[i] % set.length];
  const chars = [pick(U, 0), pick(L, 1), pick(D, 2), pick(S, 3)];
  for (let i = 4; i < 18; i++) chars.push(pick(all, i));
  // shuffle
  for (let i = chars.length - 1; i > 0; i--) {
    const j = bytes[i] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

type ArmResult =
  | { ok: true; status: number; data: Record<string, unknown> }
  | { ok: false; status: number; error: string };

/** One ARM request via node:https (follows redirects, re-attaches auth). */
function armRequest(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<ArmResult> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const doReq = (host: string, fullPath: string, hop: number): Promise<ArmResult> =>
    new Promise((resolve) => {
      const req = httpsRequest(
        {
          hostname: host,
          port: 443,
          path: fullPath,
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(payload
              ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
              : {}),
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const loc = res.headers.location as string | undefined;
          if (
            (status === 301 || status === 302 || status === 307 || status === 308) &&
            loc &&
            hop < 4
          ) {
            res.resume();
            try {
              const u = new URL(loc);
              resolve(doReq(u.hostname, `${u.pathname}${u.search}`, hop + 1));
            } catch {
              resolve({ ok: false, status, error: "bad redirect from Azure" });
            }
            return;
          }
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            let parsed: Record<string, unknown> = {};
            try {
              parsed = data ? JSON.parse(data) : {};
            } catch {
              /* non-JSON */
            }
            if (status >= 200 && status < 300) {
              resolve({ ok: true, status, data: parsed });
            } else {
              const err = parsed.error as { message?: string; code?: string } | undefined;
              resolve({
                ok: false,
                status,
                error:
                  err?.message || err?.code || `Azure returned ${status}: ${data.slice(0, 200)}`,
              });
            }
          });
        },
      );
      req.on("error", (e) =>
        resolve({ ok: false, status: 0, error: `Network error reaching Azure: ${e.message}` }),
      );
      if (payload) req.write(payload);
      req.end();
    });
  return doReq(ARM, path, 0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll a resource's provisioningState until Succeeded/Failed (or timeout). */
async function waitProvisioned(
  token: string,
  idPath: string,
  api: string,
  timeoutMs: number,
): Promise<ArmResult> {
  const deadline = Date.now() + timeoutMs;
  let last: ArmResult = { ok: false, status: 0, error: "no response" };
  while (Date.now() < deadline) {
    last = await armRequest(token, "GET", `${idPath}?api-version=${api}`);
    if (!last.ok) return last;
    const state =
      (last.data.properties as { provisioningState?: string } | undefined)?.provisioningState ?? "";
    if (state === "Succeeded") return last;
    if (state === "Failed" || state === "Canceled")
      return { ok: false, status: 0, error: `Provisioning ${state} for ${idPath}` };
    await sleep(5000);
  }
  return { ok: false, status: 0, error: `Timed out waiting for ${idPath} to provision` };
}

export type CreateVmInput = {
  resourceGroup: string;
  vmName: string;
  location?: string;
  vmSize?: string;
  osImage?: string;
  adminUsername?: string;
};

export type CreateVmResult =
  | {
      ok: true;
      vm: string;
      resourceGroup: string;
      location: string;
      vmSize: string;
      osImage: string;
      publicIp: string | null;
      adminUsername: string;
      adminPassword: string;
    }
  | { ok: false; error: string };

/**
 * Provision a Linux VM (+ its RG, VNet, subnet, public IP, NIC) over ARM REST.
 * Returns the public IP and a generated admin password (shown once).
 */
export async function createAzureVm(
  token: string,
  subscriptionId: string,
  input: CreateVmInput,
): Promise<CreateVmResult> {
  const rg = input.resourceGroup.trim();
  const vm = input.vmName.trim();
  const location = (input.location || "eastus").trim();
  const vmSize = (input.vmSize || "Standard_B1s").trim();
  const osImage = (input.osImage || "ubuntu-22.04").trim();
  const adminUsername = (input.adminUsername || "azureuser").trim();
  const img = AZURE_VM_IMAGES[osImage];
  if (!img)
    return {
      ok: false,
      error: `Unknown os_image '${osImage}'. Supported: ${Object.keys(AZURE_VM_IMAGES).join(", ")}`,
    };
  if (!/^[a-zA-Z][a-zA-Z0-9-]{0,62}$/.test(vm))
    return {
      ok: false,
      error: "VM name must start with a letter and be ≤63 chars (letters, digits, hyphens).",
    };

  const password = generatePassword();
  const sub = `/subscriptions/${subscriptionId.trim()}`;
  const base = `${sub}/resourceGroups/${encodeURIComponent(rg)}/providers`;

  // 1 — Resource group (idempotent create).
  const rgRes = await armRequest(
    token,
    "PUT",
    `${sub}/resourcegroups/${encodeURIComponent(rg)}?api-version=${API_RESOURCES}`,
    { location },
  );
  if (!rgRes.ok) return { ok: false, error: `Resource group: ${rgRes.error}` };

  // 2 — VNet + subnet.
  const vnetPath = `${base}/Microsoft.Network/virtualNetworks/${vm}-vnet`;
  const vnetRes = await armRequest(token, "PUT", `${vnetPath}?api-version=${API_NETWORK}`, {
    location,
    properties: {
      addressSpace: { addressPrefixes: ["10.0.0.0/16"] },
      subnets: [{ name: `${vm}-subnet`, properties: { addressPrefix: "10.0.0.0/24" } }],
    },
  });
  if (!vnetRes.ok) return { ok: false, error: `VNet: ${vnetRes.error}` };
  const wv = await waitProvisioned(token, vnetPath, API_NETWORK, 120_000);
  if (!wv.ok) return { ok: false, error: `VNet: ${wv.error}` };
  const subnetId =
    (wv.data.properties as { subnets?: Array<{ id?: string }> } | undefined)?.subnets?.[0]?.id ??
    `${vnetPath}/subnets/${vm}-subnet`;

  // 3 — Public IP (Standard, static).
  const ipPath = `${base}/Microsoft.Network/publicIPAddresses/${vm}-ip`;
  const ipRes = await armRequest(token, "PUT", `${ipPath}?api-version=${API_NETWORK}`, {
    location,
    sku: { name: "Standard" },
    properties: { publicIPAllocationMethod: "Static" },
  });
  if (!ipRes.ok) return { ok: false, error: `Public IP: ${ipRes.error}` };
  const wip = await waitProvisioned(token, ipPath, API_NETWORK, 120_000);
  if (!wip.ok) return { ok: false, error: `Public IP: ${wip.error}` };
  const publicIpId = (wip.data.id as string) ?? ipPath;

  // 4 — NIC.
  const nicPath = `${base}/Microsoft.Network/networkInterfaces/${vm}-nic`;
  const nicRes = await armRequest(token, "PUT", `${nicPath}?api-version=${API_NETWORK}`, {
    location,
    properties: {
      ipConfigurations: [
        {
          name: `${vm}-ipcfg`,
          properties: {
            subnet: { id: subnetId },
            publicIPAddress: { id: publicIpId },
            privateIPAllocationMethod: "Dynamic",
          },
        },
      ],
    },
  });
  if (!nicRes.ok) return { ok: false, error: `NIC: ${nicRes.error}` };
  const wnic = await waitProvisioned(token, nicPath, API_NETWORK, 120_000);
  if (!wnic.ok) return { ok: false, error: `NIC: ${wnic.error}` };
  const nicId = (wnic.data.id as string) ?? nicPath;

  // 5 — The VM (long-running; poll up to ~6 min).
  const vmPath = `${base}/Microsoft.Compute/virtualMachines/${vm}`;
  const vmRes = await armRequest(token, "PUT", `${vmPath}?api-version=${API_COMPUTE}`, {
    location,
    properties: {
      hardwareProfile: { vmSize },
      storageProfile: { imageReference: img },
      osProfile: {
        computerName: vm,
        adminUsername,
        adminPassword: password,
        linuxConfiguration: { disablePasswordAuthentication: false },
      },
      networkProfile: { networkInterfaces: [{ id: nicId }] },
    },
    tags: { "created-by": "deepagent" },
  });
  if (!vmRes.ok) return { ok: false, error: `VM: ${vmRes.error}` };
  const wvm = await waitProvisioned(token, vmPath, API_COMPUTE, 360_000);
  if (!wvm.ok) return { ok: false, error: `VM: ${wvm.error}` };

  // Read the public IP address that got allocated.
  const ipFinal = await armRequest(token, "GET", `${ipPath}?api-version=${API_NETWORK}`);
  const publicIp = ipFinal.ok
    ? ((ipFinal.data.properties as { ipAddress?: string } | undefined)?.ipAddress ?? null)
    : null;

  return {
    ok: true,
    vm,
    resourceGroup: rg,
    location,
    vmSize,
    osImage,
    publicIp,
    adminUsername,
    adminPassword: password,
  };
}

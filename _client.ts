import { z } from "npm:zod@4.3.6";

/**
 * Google Meet Hardware monitoring client.
 *
 * Uses a GCP service account with domain-wide delegation to access
 * the Google Workspace Admin Reports API (meet_hardware application).
 *
 * The service account must be authorized in the target Workspace domain's
 * Admin Console under Security > API Controls > Domain-wide Delegation
 * with scope: https://www.googleapis.com/auth/admin.reports.audit.readonly
 *
 * Credentials are passed via globalArguments, typically from vault:
 *   serviceAccountJson: ${{ vault.get(<vault>, google-sa-json) }}
 *   adminEmail:         admin user to impersonate (e.g., admin@customer.com)
 *   customerId:         Workspace customer ID (e.g., C04je7dsl)
 */

export const GoogleMeetHardwareGlobalArgsSchema = z.object({
  serviceAccountJson: z.string().meta({ sensitive: true }).describe(
    "GCP service account JSON key (entire file contents). Use: ${{ vault.get(<vault>, google-sa-json) }}",
  ),
  adminEmail: z.string().describe(
    "Workspace admin email to impersonate via domain-wide delegation",
  ),
  customerId: z.string().describe(
    "Google Workspace customer ID (e.g., C04je7dsl)",
  ),
});

// --- JWT / OAuth helpers (zero external dependencies) ---

function base64url(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}

function base64urlEncode(str: string): string {
  return base64url(new TextEncoder().encode(str));
}

async function signRS256(
  message: string,
  privateKeyPem: string,
): Promise<string> {
  const tmpKey = await Deno.makeTempFile({ suffix: ".pem" });
  try {
    await Deno.writeTextFile(tmpKey, privateKeyPem);
    const signCmd = new Deno.Command("openssl", {
      args: ["dgst", "-sha256", "-sign", tmpKey],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    const signProc = signCmd.spawn();
    const writer = signProc.stdin.getWriter();
    await writer.write(new TextEncoder().encode(message));
    await writer.close();
    const output = await signProc.output();
    if (!output.success) {
      const stderr = new TextDecoder().decode(output.stderr);
      throw new Error(`openssl signing failed: ${stderr}`);
    }
    return base64url(output.stdout);
  } finally {
    try {
      await Deno.remove(tmpKey);
    } catch { /* ignore */ }
  }
}

interface TokenCache {
  token: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;

async function getAccessToken(
  serviceAccountJson: string,
  adminEmail: string,
): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const sa = JSON.parse(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);

  const header = base64urlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64urlEncode(JSON.stringify({
    iss: sa.client_email,
    sub: adminEmail,
    scope: "https://www.googleapis.com/auth/admin.reports.audit.readonly",
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  }));

  const signature = await signRS256(`${header}.${payload}`, sa.private_key);
  const jwt = `${header}.${payload}.${signature}`;

  const resp = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Token exchange failed (${resp.status}): ${body}`);
  }

  const tokenData = await resp.json();
  tokenCache = {
    token: tokenData.access_token,
    expiresAt: Date.now() + 50 * 60 * 1000, // refresh 10 min before expiry
  };
  return tokenCache.token;
}

// --- Reports API client ---

export interface MeetHardwareEvent {
  time: string;
  eventType: string;
  eventName: string;
  deviceId: string;
  serialNumber: string;
  displayName: string;
  uniqueQualifier: string;
  parameters: Record<string, unknown>;
  peripheralData?: {
    name: string;
    type: string;
    supportedState: string;
    active: boolean;
    isDefault: boolean;
  };
  eventData?: Record<string, unknown>;
}

function parseEvent(item: Record<string, unknown>): MeetHardwareEvent[] {
  const results: MeetHardwareEvent[] = [];
  const id = item.id as Record<string, unknown>;
  const events = item.events as Array<Record<string, unknown>>;

  for (const evt of events) {
    const params: Record<string, unknown> = {};
    let peripheralData: MeetHardwareEvent["peripheralData"] = undefined;
    let eventData: Record<string, unknown> | undefined = undefined;

    for (const p of (evt.parameters as Array<Record<string, unknown>>) || []) {
      const name = p.name as string;
      if (name === "AFFECTED_PERIPHERAL" && p.messageValue) {
        const msgParams = (p.messageValue as Record<string, unknown>)
          .parameter as Array<Record<string, unknown>>;
        const pData: Record<string, unknown> = {};
        for (const mp of msgParams || []) {
          pData[mp.name as string] = mp.value ?? mp.boolValue ?? mp.intValue ??
            "";
        }
        peripheralData = {
          name: (pData.NAME || pData.PERIPHERAL_NAME || "") as string,
          type: (pData.PERIPHERAL_TYPE || "") as string,
          supportedState: (pData.SUPPORTED_STATE || "") as string,
          active: Boolean(pData.ACTIVE),
          isDefault: Boolean(pData.IS_DEFAULT),
        };
      } else if (name === "EVENT_DATA" && p.messageValue) {
        const msgParams = (p.messageValue as Record<string, unknown>)
          .parameter as Array<Record<string, unknown>>;
        eventData = {};
        for (const mp of msgParams || []) {
          eventData[mp.name as string] = mp.value ?? mp.boolValue ??
            mp.intValue ?? "";
        }
      } else {
        params[name] = p.value ?? p.boolValue ?? p.intValue ?? "";
      }
    }

    results.push({
      time: id.time as string,
      eventType: evt.type as string,
      eventName: evt.name as string,
      deviceId: (params.DEVICE_ID || "") as string,
      serialNumber: (params.SERIAL_NUMBER || "") as string,
      displayName: (params.DEVICE_DISPLAY_NAME || "") as string,
      uniqueQualifier: id.uniqueQualifier as string,
      parameters: params,
      peripheralData,
      eventData,
    });
  }
  return results;
}

export async function fetchMeetHardwareEvents(
  globalArgs: z.infer<typeof GoogleMeetHardwareGlobalArgsSchema>,
  options?: {
    startTime?: string;
    eventName?: string;
    maxResults?: number;
  },
): Promise<MeetHardwareEvent[]> {
  const token = await getAccessToken(
    globalArgs.serviceAccountJson,
    globalArgs.adminEmail,
  );
  const allEvents: MeetHardwareEvent[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(
      "https://admin.googleapis.com/admin/reports/v1/activity/users/all/applications/meet_hardware",
    );
    url.searchParams.set("maxResults", String(options?.maxResults || 500));
    if (options?.startTime) {
      url.searchParams.set("startTime", options.startTime);
    }
    if (options?.eventName) {
      url.searchParams.set("eventName", options.eventName);
    }
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Reports API ${resp.status}: ${body}`);
    }

    const data = await resp.json();
    for (const item of data.items || []) {
      allEvents.push(...parseEvent(item));
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return allEvents;
}

// --- State table computation ---

export interface DeviceState {
  deviceId: string;
  serialNumber: string;
  displayName: string;
  status: "online" | "offline" | "unknown";
  statusSince: string;
  callState: "idle" | "in_call";
  callPlatform?: string;
  callSince?: string;
  powerState: "awake" | "sleeping";
  powerSince?: string;
  peripherals: Record<string, {
    name: string;
    type: string;
    connected: boolean;
    since: string;
  }>;
  lastFirmwareUpdate?: { type: string; time: string };
  lastRestart?: { type: string; time: string };
  lastEventAt: string;
  eventCount: number;
}

export function buildStateTable(
  events: MeetHardwareEvent[],
): Record<string, DeviceState> {
  const devices: Record<string, DeviceState> = {};

  // Sort chronologically (oldest first) so we process in order
  const sorted = [...events].sort((a, b) => a.time.localeCompare(b.time));

  for (const evt of sorted) {
    if (!evt.deviceId) continue;

    if (!devices[evt.deviceId]) {
      devices[evt.deviceId] = {
        deviceId: evt.deviceId,
        serialNumber: evt.serialNumber,
        displayName: evt.displayName,
        status: "unknown",
        statusSince: evt.time,
        callState: "idle",
        powerState: "awake",
        peripherals: {},
        lastEventAt: evt.time,
        eventCount: 0,
      };
    }

    const dev = devices[evt.deviceId];
    dev.lastEventAt = evt.time;
    dev.eventCount++;
    // Update display name / serial if we get a newer one
    if (evt.displayName) dev.displayName = evt.displayName;
    if (evt.serialNumber) dev.serialNumber = evt.serialNumber;

    switch (evt.eventName) {
      // Connectivity
      case "EVENT_DEVICE_FOUND":
        dev.status = "online";
        dev.statusSince = evt.time;
        break;
      case "EVENT_DEVICE_MISSING":
        dev.status = "offline";
        dev.statusSince = evt.time;
        break;

      // Call state
      case "EVENT_MEET_CALL_JOINED":
      case "EVENT_TEAMS_CALL_JOINED":
      case "EVENT_WEBEX_CALL_JOINED":
      case "EVENT_ZOOM_CALL_JOINED":
        dev.callState = "in_call";
        dev.callPlatform = evt.eventName.replace("EVENT_", "").replace(
          "_CALL_JOINED",
          "",
        ).toLowerCase();
        dev.callSince = evt.time;
        break;
      case "EVENT_MEET_CALL_DISCONNECTED":
      case "EVENT_TEAMS_CALL_DISCONNECTED":
      case "EVENT_WEBEX_CALL_DISCONNECTED":
      case "EVENT_ZOOM_CALL_DISCONNECTED":
        dev.callState = "idle";
        dev.callPlatform = undefined;
        dev.callSince = undefined;
        break;

      // Power state
      case "EVENT_SLEEP_SCREEN_ENTERED":
        dev.powerState = "sleeping";
        dev.powerSince = evt.time;
        break;
      case "EVENT_SLEEP_SCREEN_EXITED":
        dev.powerState = "awake";
        dev.powerSince = evt.time;
        break;

      // Peripherals
      case "EVENT_CAMERA_ATTACHED":
      case "EVENT_ADD_ON_CAMERA_ATTACHED":
      case "EVENT_MIC_ATTACHED":
      case "EVENT_SPEAKER_ATTACHED":
      case "EVENT_DISPLAY_ATTACHED":
      case "EVENT_TOUCH_CONTROLLER_ATTACHED":
      case "EVENT_HANDHELD_CONTROLLER_ATTACHED":
      case "EVENT_VIDEO_CAPTURE_CONTENT_CAMERA_ATTACHED":
        if (evt.peripheralData) {
          const key = evt.peripheralData.type || evt.eventName;
          dev.peripherals[key] = {
            name: evt.peripheralData.name,
            type: evt.peripheralData.type,
            connected: true,
            since: evt.time,
          };
        }
        break;
      case "EVENT_CAMERA_DETACHED":
      case "EVENT_ADD_ON_CAMERA_DETACHED":
      case "EVENT_MIC_DETACHED":
      case "EVENT_SPEAKER_DETACHED":
      case "EVENT_DISPLAY_DETACHED":
      case "EVENT_TOUCH_CONTROLLER_DETACHED":
      case "EVENT_HANDHELD_CONTROLLER_DETACHED":
      case "EVENT_VIDEO_CAPTURE_CONTENT_CAMERA_DETACHED":
        if (evt.peripheralData) {
          const key = evt.peripheralData.type || evt.eventName;
          dev.peripherals[key] = {
            name: evt.peripheralData.name,
            type: evt.peripheralData.type,
            connected: false,
            since: evt.time,
          };
        }
        break;

      // Firmware
      case "EVENT_OS_UPDATE":
      case "EVENT_BROWSER_UPDATE":
      case "EVENT_CLIENT_APP_UPDATE":
        dev.lastFirmwareUpdate = { type: evt.eventName, time: evt.time };
        break;

      // Restarts
      case "EVENT_RESTART_MACHINE":
      case "EVENT_RESTART_APP":
      case "EVENT_RESTART_UNKNOWN":
        dev.lastRestart = { type: evt.eventName, time: evt.time };
        break;
    }
  }

  return devices;
}

export function sanitizeId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

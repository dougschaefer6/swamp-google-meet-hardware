# Google Meet Hardware Extension for Swamp

A swamp extension that monitors Google Meet hardware devices through the Google Workspace Admin Reports API. Each device's online/offline state, call activity, peripheral connections, power state, firmware updates, and restart history are computed from the past 24 hours of `meet_hardware` audit events and surfaced as structured swamp data artifacts.

This is built for managed-service operators and IT teams who run Meet hardware fleets and want device-level observability without relying on the Workspace admin console UI. It uses a service account with domain-wide delegation, so no interactive authentication is required — the extension authenticates as a designated admin user and pulls events server-side.

The Reports API is the same source the Workspace admin console uses for its hardware status views. Event types covered include `device_online`, `device_offline`, `peripherals_changed`, `call_started`, `call_ended` (with platform — Meet, Teams, Webex, or Zoom), `device_woke`, `device_slept`, `firmware_updated`, and `device_restarted`.

## Prerequisites

- Google Workspace tenant with at least one Meet hardware device (Logitech Rally Bar, Acer Chromebox, Asus Hangouts Meet kit, etc.)
- A GCP project with the Admin SDK API enabled
- A service account in that project with a JSON key
- Domain-wide delegation authorized in the target Workspace tenant for the service account, with scope `https://www.googleapis.com/auth/admin.reports.audit.readonly`
- The Workspace customer ID (visible in the Workspace admin console under Account Settings)
- An admin user email for the service account to impersonate
- Swamp installed and a repository initialized
- `openssl` available on `PATH` (used to sign the JWT for OAuth token exchange)

## Installation

```bash
swamp extension pull @dougschaefer/google-meet-hardware
```

## Setup

Create a vault and store the service account JSON:

```bash
swamp vault create local_encryption gworkspace
cat /path/to/service-account-key.json | swamp vault put gworkspace google-sa-json
```

Create a model instance wired to the vault and your tenant settings:

```bash
swamp model create @dougschaefer/google-meet-hardware meet-devices \
  --global-arg 'serviceAccountJson=${{ vault.get("gworkspace", "google-sa-json") }}' \
  --global-arg 'adminEmail=admin@yourdomain.com' \
  --global-arg 'customerId=C04je7dsl'
```

The `customerId` is your Workspace customer ID (visible at admin.google.com under Account Settings). The `adminEmail` must be a real Workspace admin in your tenant — the service account impersonates this user when calling the Reports API.

## Methods

| Method | Description |
|--------|-------------|
| `sync` | Fetch the past 24 hours of `meet_hardware` audit events and compute current device state. One data artifact is produced per device, named `<displayName>-<deviceIdPrefix>` |

## Usage

```bash
swamp model method run meet-devices sync
```

Each device produces a data artifact with computed state:

```bash
swamp data list meet-devices --json
```

Sample output schema for a single device:

```json
{
  "deviceId": "device-id-from-google",
  "serialNumber": "GM4-12345-67890",
  "displayName": "Boardroom-A",
  "status": "online",
  "statusSince": "2026-04-27T08:14:23.000Z",
  "callState": "in_call",
  "callPlatform": "Meet",
  "callSince": "2026-04-27T13:02:11.000Z",
  "powerState": "awake",
  "powerSince": "2026-04-27T08:14:23.000Z",
  "peripherals": {
    "camera": { "name": "Logitech Rally Camera", "type": "camera", "connected": true, "since": "2026-04-27T08:14:23.000Z" },
    "speaker": { "name": "Rally Speaker", "type": "speaker", "connected": true, "since": "2026-04-27T08:14:23.000Z" }
  },
  "lastFirmwareUpdate": { "type": "self_updated", "time": "2026-04-25T03:12:08.000Z" },
  "lastRestart": { "type": "user_restart", "time": "2026-04-26T17:45:00.000Z" },
  "lastEventAt": "2026-04-27T13:02:11.000Z",
  "eventCount": 47
}
```

## Why service account + domain-wide delegation instead of OAuth

The Workspace Reports API only exposes `meet_hardware` events to admin users. OAuth user-token flows would require an interactive admin to log in, store a refresh token, and rotate it periodically. Service accounts with domain-wide delegation skip all of that — the GCP-side key is the only credential, and it has scoped read-only access to one specific API. This is the pattern Google recommends for automated monitoring systems and is what the Workspace admin console itself uses internally.

## Polling Cadence

The Reports API has a 1–3 hour delay before events become queryable. A 5-minute polling interval is appropriate — events finalize hours later but state computation needs to refresh frequently enough to stay current. Run `sync` on a swamp workflow with cron-style scheduling.

## Quality and Testing

This extension has been tested against live Workspace tenants with Logitech Rally Bar and Acer Chromebox Meet hardware. American Sound is solely responsible for this integration. Google does not provide direct support for third-party swamp extensions.

## License

MIT. See [LICENSE](LICENSE) for details.

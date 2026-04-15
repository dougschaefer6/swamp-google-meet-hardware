# Google Meet Hardware Monitoring — Swamp Extension

Monitor Google Meet hardware devices (Series One, Neat, Poly, ASUS kits) through the Google Workspace Admin Reports API. Tracks device online/offline state, peripheral connectivity, call state across platforms (Meet, Teams, Webex, Zoom), power state, firmware updates, and restarts.

## What This Does

Google Meet hardware devices report events to the Workspace Admin Reports API under the `meet_hardware` application. This extension polls those events and computes a current state table for each device — turning an event stream into a queryable device inventory with real-time status.

### Monitored Data

| Category | Events |
|---|---|
| **Device connectivity** | Online/offline detection via Google's server-side heartbeat (~3 min latency) |
| **Peripherals** | Camera, microphone, speaker, display, touch controller, handheld controller attach/detach |
| **Call state** | Join/disconnect for Google Meet, Microsoft Teams, Webex, and Zoom calls |
| **Power state** | Sleep/wake transitions |
| **Software** | OS updates, browser updates, client app updates |
| **Restarts** | Machine reboots, app restarts |
| **Application health** | Frontend load success/failure, auth errors, network issues, firmware update status |

61 event types across 5 categories (ACTIVITY, ISSUE, RESTART, SOFTWARE_UPDATE, FEEDBACK_FILED).

## Prerequisites

### GCP Service Account

1. Create a service account in a GCP project
2. Generate a JSON key
3. Enable the **Admin SDK API** on the project

### Google Workspace Domain-Wide Delegation

In the Workspace Admin Console (admin.google.com):

1. Go to Security > API Controls > Domain-wide Delegation
2. Add the service account's **Client ID** (numeric, from the SA details page)
3. Authorize scope: `https://www.googleapis.com/auth/admin.reports.audit.readonly`

### Google Workspace Customer ID

Find at admin.google.com > Account > Account settings. Format: `C0xxxxxxx`.

## Installation

```bash
swamp extension pull @dougschaefer/google-meet-hardware
```

## Setup

Store the service account JSON key in a vault:

```bash
cat /path/to/service-account-key.json | swamp vault put <vault-name> google-sa-json
```

Create a model instance:

```bash
swamp model create @dougschaefer/google-meet-hardware meet-monitor \
  --global-arg serviceAccountJson='${{ vault.get(<vault-name>, google-sa-json) }}' \
  --global-arg adminEmail='admin@yourdomain.com' \
  --global-arg customerId='C0xxxxxxx'
```

## Methods

### sync

Fetches events from the past 24 hours and computes current device state for all devices.

```bash
swamp model method run meet-monitor sync --json
```

Returns one resource per device with: status, peripherals, call state, power state, last restart, last firmware update.

### list-devices

Scans 30 days of event history to discover all devices and their current state.

```bash
swamp model method run meet-monitor list-devices --json
```

### device-status

Get current status for a specific device.

```bash
swamp model method run meet-monitor device-status \
  --input '{"serialNumber": "NH12450000178"}' --json
```

### events

Fetch raw events with optional filtering.

```bash
# All events from the past 24 hours
swamp model method run meet-monitor events --json

# Filter by event type
swamp model method run meet-monitor events \
  --input '{"eventName": "EVENT_DEVICE_MISSING"}' --json

# Custom time range
swamp model method run meet-monitor events \
  --input '{"startTime": "2026-04-15T00:00:00Z"}' --json
```

## Authentication Model

This extension uses a GCP service account with domain-wide delegation — the same pattern used by Webex Control Hub integrations. The customer creates the service account in their own GCP project, authorizes specific scopes in their Workspace Admin Console, and provides the JSON key. The customer retains full control and can revoke access at any time.

No interactive login, no MFA prompts, no token refresh — the JWT grant flow handles everything automatically.

## Architecture Notes

The Google Workspace Admin Reports API is event-driven, not a real-time status API. This extension builds a state table by replaying events chronologically:

- `EVENT_DEVICE_FOUND` sets device status to "online"
- `EVENT_DEVICE_MISSING` sets device status to "offline"
- `EVENT_CAMERA_ATTACHED` marks the camera as connected
- And so on for all 61 event types

Between events, the last known state carries forward. Google's server-side heartbeat generates `DEVICE_FOUND`/`DEVICE_MISSING` events with ~3 minute detection latency — this is not dependent on the device initiating a sync.

## License

MIT

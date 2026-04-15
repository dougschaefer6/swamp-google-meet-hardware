# @dougschaefer/google-meet-hardware

Google Meet hardware device monitoring via Workspace Admin Reports API. Tracks device online/offline state, peripheral attach/detach (camera, mic, speaker, display, touch controller), call state (Meet, Teams, Webex, Zoom), power state, firmware updates, and restarts. Uses service account with domain-wide delegation — no interactive auth required.

## Installation

```bash
swamp extension pull @dougschaefer/google-meet-hardware
```

## Version

Current: `2026.04.15.2`

## Source Files

- `_client.ts`
- `device.ts`
- `manifest.yaml`

## Setup

See the manifest for required global arguments and configuration:

```bash
swamp model type describe @dougschaefer/google-meet-hardware --json
```

## License

MIT

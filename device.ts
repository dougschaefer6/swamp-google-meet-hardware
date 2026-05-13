// deno-lint-ignore-file no-explicit-any
import { z } from "npm:zod@4.3.6";
import {
  buildStateTable,
  fetchMeetHardwareEvents,
  GoogleMeetHardwareGlobalArgsSchema,
  sanitizeId,
} from "./_client.ts";

const PeripheralSchema = z.object({
  name: z.string(),
  type: z.string(),
  connected: z.boolean(),
  since: z.string(),
}).passthrough();

const DeviceStateSchema = z.object({
  deviceId: z.string(),
  serialNumber: z.string(),
  displayName: z.string(),
  status: z.enum(["online", "offline", "unknown"]),
  statusSince: z.string(),
  callState: z.enum(["idle", "in_call"]),
  callPlatform: z.string().optional(),
  callSince: z.string().optional(),
  powerState: z.enum(["awake", "sleeping"]),
  powerSince: z.string().optional(),
  peripherals: z.record(z.string(), PeripheralSchema),
  lastFirmwareUpdate: z.object({
    type: z.string(),
    time: z.string(),
  }).optional(),
  lastRestart: z.object({
    type: z.string(),
    time: z.string(),
  }).optional(),
  lastEventAt: z.string(),
  eventCount: z.number(),
}).passthrough();

/**
 * `@dougschaefer/google-meet-hardware` model — monitors Google Meet
 * hardware (Series One, Acer Chromebox, ASUS, etc.) via the Workspace
 * Admin Reports API. Authentication uses a service account with
 * domain-wide delegation. Sync enumerates the device fleet across an
 * Admin SDK customer, capturing online/offline state, peripheral
 * attribution, last event time, and rolling event count. Events
 * returns the activity timeline for a single device (online, offline,
 * peripheral connected/disconnected, error states) — useful for
 * correlating outages against the Utelogy alert stream.
 */
export const model = {
  type: "@dougschaefer/google-meet-hardware",
  version: "2026.04.15.2",
  globalArguments: GoogleMeetHardwareGlobalArgsSchema,
  resources: {
    device: {
      description:
        "Google Meet hardware device with computed state from Reports API events",
      schema: DeviceStateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    sync: {
      description:
        "Sync all Meet hardware device state from the Reports API. " +
        "Fetches events from the past 24 hours and computes current device state.",
      arguments: z.object({}),
      execute: async (_args: any, context: any) => {
        const events = await fetchMeetHardwareEvents(context.globalArgs, {
          startTime: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        });

        context.logger.info("Fetched {count} meet_hardware events", {
          count: events.length,
        });

        const stateTable = buildStateTable(events);
        const devices = Object.values(stateTable);

        context.logger.info("Computed state for {count} devices", {
          count: devices.length,
        });

        const handles = [];
        for (const dev of devices) {
          const name = sanitizeId(
            `${dev.displayName || "device"}-${dev.deviceId.slice(0, 8)}`,
          );
          const handle = await context.writeResource("device", name, dev);
          handles.push(handle);
        }

        return { dataHandles: handles };
      },
    },

    events: {
      description:
        "Fetch raw Meet hardware events. Supports filtering by event name " +
        "and time range.",
      arguments: z.object({
        startTime: z.string().optional().describe(
          "ISO timestamp to start from (default: 24 hours ago)",
        ),
        eventName: z.string().optional().describe(
          "Filter to a specific event (e.g., EVENT_DEVICE_FOUND, EVENT_CAMERA_DETACHED)",
        ),
        maxResults: z.number().optional().default(500).describe(
          "Maximum events to return",
        ),
      }),
      execute: async (args: any, context: any) => {
        const startTime = args.startTime ||
          new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

        const events = await fetchMeetHardwareEvents(context.globalArgs, {
          startTime,
          eventName: args.eventName,
          maxResults: args.maxResults,
        });

        context.logger.info("Fetched {count} events", { count: events.length });

        const handle = await context.writeResource("device", "events-query", {
          deviceId: "query",
          serialNumber: "",
          displayName: "Events Query Result",
          status: "unknown",
          statusSince: startTime,
          callState: "idle",
          powerState: "awake",
          peripherals: {},
          lastEventAt: new Date().toISOString(),
          eventCount: events.length,
          _events: events,
          _filter: args.eventName || "all",
        });

        return { dataHandles: [handle] };
      },
    },

    "list-devices": {
      description:
        "List all known Meet hardware devices by scanning 30 days of event history.",
      arguments: z.object({}),
      execute: async (_args: any, context: any) => {
        const events = await fetchMeetHardwareEvents(context.globalArgs, {
          startTime: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
            .toISOString(),
        });

        const stateTable = buildStateTable(events);
        const devices = Object.values(stateTable).map((dev) => ({
          deviceId: dev.deviceId,
          serialNumber: dev.serialNumber,
          displayName: dev.displayName,
          status: dev.status,
          statusSince: dev.statusSince,
          lastEventAt: dev.lastEventAt,
          eventCount: dev.eventCount,
          peripheralCount: Object.keys(dev.peripherals).length,
        }));

        context.logger.info("Found {count} devices from 30-day event history", {
          count: devices.length,
        });

        const handles = [];
        for (const dev of Object.values(stateTable)) {
          const name = sanitizeId(
            `${dev.displayName || "device"}-${dev.deviceId.slice(0, 8)}`,
          );
          const handle = await context.writeResource("device", name, dev);
          handles.push(handle);
        }

        return { dataHandles: handles };
      },
    },

    "device-status": {
      description:
        "Get current status for a specific device by ID or serial number.",
      arguments: z.object({
        deviceId: z.string().optional().describe("Device ID"),
        serialNumber: z.string().optional().describe("Device serial number"),
      }),
      execute: async (args: any, context: any) => {
        if (!args.deviceId && !args.serialNumber) {
          throw new Error("Provide either deviceId or serialNumber");
        }

        const events = await fetchMeetHardwareEvents(context.globalArgs, {
          startTime: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
            .toISOString(),
        });

        const stateTable = buildStateTable(events);
        const device = Object.values(stateTable).find((d) =>
          (args.deviceId && d.deviceId === args.deviceId) ||
          (args.serialNumber && d.serialNumber === args.serialNumber)
        );

        if (!device) {
          throw new Error(
            `Device not found: ${args.deviceId || args.serialNumber}`,
          );
        }

        const name = sanitizeId(device.displayName || device.deviceId);
        const handle = await context.writeResource("device", name, device);

        return { dataHandles: [handle] };
      },
    },
  },
};

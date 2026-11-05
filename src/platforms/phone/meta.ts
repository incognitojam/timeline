import type { PlatformMeta } from "../types";

export const phoneMeta = {
  id: "phone",
  color: "#2dd4bf",
  sources: [
    {
      id: "phone",
      label: "Phone",
      traits: { conversation: "social", phoneIdentity: true, corpus: true },
      eventTypes: [
        "call:incoming",
        "call:outgoing",
        "call:missed",
        "call:voicemail",
        "call:rejected",
        "call:blocked",
        "call:type*",
        "sms:received",
        "sms:sent",
        "sms:draft",
        "sms:outbox",
        "sms:failed",
        "sms:queued",
        "sms:type*",
        "mms:received",
        "mms:sent",
        "mms:draft",
        "mms:outbox",
        "mms:type*",
      ],
    },
    {
      id: "sms-backup-restore",
      label: "SMS Backup & Restore",
    },
  ],
  identityPlatforms: ["phone"],
} as const satisfies PlatformMeta;

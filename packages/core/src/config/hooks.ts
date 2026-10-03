export * as ConfigHooks from "./hooks"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

export class Entry extends Schema.Class<Entry>("ConfigV2.Hooks.Entry")({
  type: Schema.Literals(["command", "http", "prompt", "classify"]).pipe(Schema.optional).annotate({
    description: "Hook type (default command). command needs `command`, http needs `url`, prompt needs `prompt`, classify needs `question`",
  }),
  matcher: Schema.String.pipe(Schema.optional).annotate({
    description: "Regular expression matched against the tool name (or permission name). Omit to match everything",
  }),
  command: Schema.String.pipe(Schema.optional).annotate({
    description: "type command: shell command run with sh -c in the project directory. The event JSON is written to stdin",
  }),
  url: Schema.String.pipe(Schema.optional).annotate({
    description:
      "type http: URL that receives the event JSON as a POST. A 2xx JSON response follows the command stdout contract",
  }),
  headers: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional).annotate({
    description: "type http: request headers; $VAR and ${VAR} are expanded from the environment",
  }),
  prompt: Schema.String.pipe(Schema.optional).annotate({
    description:
      'type prompt: prompt sent to the provider\'s small model, $ARGUMENTS is replaced by the event JSON. The model must answer {"ok": boolean, "reason"?: string}; ok=false blocks',
  }),
  question: Schema.String.pipe(Schema.optional).annotate({
    description:
      "type classify: yes/no question about the event JSON, answered by Jev (TypeSafe) as a probability. Needs TYPESAFE_API_KEY",
  }),
  threshold: Schema.Number.pipe(Schema.optional).annotate({
    description: "type classify: probability from which the hook blocks (0..1, default 0.5)",
  }),
  reason: Schema.String.pipe(Schema.optional).annotate({
    description: "type classify: block reason shown to the model (default \"Blocked by classify hook\")",
  }),
  timeout: PositiveInt.pipe(Schema.optional).annotate({ description: "Timeout in milliseconds (default 60000)" }),
}) {}

const Entries = Entry.pipe(Schema.Array)

export class Info extends Schema.Class<Info>("ConfigV2.Hooks")({
  PreToolUse: Entries.pipe(Schema.optional),
  PostToolUse: Entries.pipe(Schema.optional),
  PostToolUseFailure: Entries.pipe(Schema.optional),
  UserPromptSubmit: Entries.pipe(Schema.optional),
  SessionStart: Entries.pipe(Schema.optional),
  SessionEnd: Entries.pipe(Schema.optional),
  Stop: Entries.pipe(Schema.optional),
  SubagentStop: Entries.pipe(Schema.optional),
  PreCompact: Entries.pipe(Schema.optional),
  PermissionRequest: Entries.pipe(Schema.optional),
  Notification: Entries.pipe(Schema.optional),
}) {}

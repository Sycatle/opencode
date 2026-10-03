export * as ConfigHooks from "./hooks"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

export class Entry extends Schema.Class<Entry>("ConfigV2.Hooks.Entry")({
  matcher: Schema.String.pipe(Schema.optional).annotate({
    description: "Regular expression matched against the tool name (or permission name). Omit to match everything",
  }),
  command: Schema.String.annotate({
    description: "Shell command run with sh -c in the project directory. The event JSON is written to stdin",
  }),
  timeout: PositiveInt.pipe(Schema.optional).annotate({ description: "Timeout in milliseconds (default 60000)" }),
}) {}

const Entries = Entry.pipe(Schema.Array)

export class Info extends Schema.Class<Info>("ConfigV2.Hooks")({
  PreToolUse: Entries.pipe(Schema.optional),
  PostToolUse: Entries.pipe(Schema.optional),
  UserPromptSubmit: Entries.pipe(Schema.optional),
  SessionStart: Entries.pipe(Schema.optional),
  Stop: Entries.pipe(Schema.optional),
  PreCompact: Entries.pipe(Schema.optional),
  PermissionRequest: Entries.pipe(Schema.optional),
}) {}

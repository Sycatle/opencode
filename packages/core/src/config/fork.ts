export * as ConfigFork from "./fork"

import { Schema } from "effect"

// Fork feature switches and values, keyed by the OPENCODE_FORK_* name without its prefix ({ "MESSAGING": false,
// "BUDGET_USD": 5 }). The environment wins over the config; packages/fork/src/flags.ts lists every name.
export const Info = Schema.Record(Schema.String, Schema.Union([Schema.Boolean, Schema.Finite, Schema.String]))
export type Info = Schema.Schema.Type<typeof Info>

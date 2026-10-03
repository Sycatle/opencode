export * as ConfigSandbox from "./sandbox"

import { Schema } from "effect"

export class Network extends Schema.Class<Network>("ConfigV2.Sandbox.Network")({
  allow: Schema.String.pipe(Schema.Array).annotate({
    description:
      "Domains the sandboxed commands may reach. A non-empty list leaves the network open (there is no per-domain filtering); an empty list cuts it off",
  }),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Sandbox")({
  enabled: Schema.Boolean.annotate({
    description:
      "Run bash commands inside a bubblewrap sandbox (Linux only; falls back to no sandbox when bwrap is missing)",
  }),
  network: Network.pipe(Schema.optional),
  write: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Paths that stay writable in addition to the project and /tmp",
  }),
  read_deny: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Paths hidden from the sandboxed commands (default ~/.ssh, ~/.aws, ~/.gnupg, ~/.config/gh)",
  }),
}) {}

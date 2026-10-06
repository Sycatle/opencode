import { createStore } from "solid-js/store"
import { ForkClassifier } from "@opencode-fork/core/classifier"
import { useArgs } from "./args"
import { createSimpleContext } from "./helper"

// FORK-SEAM: permission-mode
// `yolo` approves every request client-side (the old upstream "auto"). The fork's modes (build, plan, auto)
// live in each session's permission ruleset (ForkClassifier marker), so they are kept per session
// and judged on the server; `draft` is the stored mode a session created from the home screen starts with.
export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  init: () => {
    const args = useArgs()
    const [store, setStore] = createStore<{ yolo: boolean; draft: ForkClassifier.StoredMode }>({
      yolo: !!args.yolo,
      draft: args.auto ? "auto" : "normal",
    })
    return {
      get yolo() {
        return store.yolo
      },
      get draft() {
        return store.draft
      },
      setDraft(mode: ForkClassifier.StoredMode) {
        setStore("draft", mode)
      },
    }
  },
})

import { createContext, type JSX, useContext } from "solid-js"
import { missingImageTool, read, write } from "../clipboard"

export type ClipboardContent = Readonly<{ data: string; mime: string }>
export type ClipboardService = Readonly<{
  read?(): Promise<ClipboardContent | undefined>
  write?(text: string): Promise<void>
  // Name of the system package to install to paste images, when it is missing.
  missingImageTool?(): Promise<string | undefined>
}>
const clipboard = { read, write, missingImageTool }
const ClipboardContext = createContext<ClipboardService>(clipboard)

export function ClipboardProvider(props: { value?: ClipboardService; children: JSX.Element }) {
  return <ClipboardContext.Provider value={props.value ?? clipboard}>{props.children}</ClipboardContext.Provider>
}

export function useClipboard() {
  return useContext(ClipboardContext)
}

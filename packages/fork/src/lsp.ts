import path from "path"
import { fileURLToPath } from "url"

export const DEFAULT = true

export const MAX_LINES = 200
const MAX_SOURCE = 160
const MAX_HOVER = 4000

export type Reader = (file: string) => Promise<string | undefined>

export type Options = {
  root: string
  read?: Reader
}

type Json = Record<string, unknown>

const KINDS = [
  "",
  "File",
  "Module",
  "Namespace",
  "Package",
  "Class",
  "Method",
  "Property",
  "Field",
  "Constructor",
  "Enum",
  "Interface",
  "Function",
  "Variable",
  "Constant",
  "String",
  "Number",
  "Boolean",
  "Array",
  "Object",
  "Key",
  "Null",
  "EnumMember",
  "Struct",
  "Event",
  "Operator",
  "TypeParameter",
]

export function enabled() {
  return process.env.OPENCODE_FORK_LSP_FORMAT !== "0"
}

export async function format(operation: string, result: readonly unknown[], options: Options) {
  const lines = await toLines(operation, result, options)
  if (!lines) return JSON.stringify(result)
  if (lines.length <= MAX_LINES) return lines.join("\n")
  return [...lines.slice(0, MAX_LINES), `... ${lines.length - MAX_LINES} more`].join("\n")
}

async function toLines(operation: string, result: readonly unknown[], options: Options) {
  const items = result.filter(isObject)
  if (items.length !== result.length) return undefined
  if (operation === "hover") return hover(items)
  if (operation === "documentSymbol" || operation === "workspaceSymbol") return symbols(items, options)
  if (operation === "prepareCallHierarchy") return all(items.map((item) => callItem(item, options)))
  if (operation === "incomingCalls") return all(items.map((item) => callItem(item.from, options)))
  if (operation === "outgoingCalls") return all(items.map((item) => callItem(item.to, options)))
  const cache = new Map<string, Promise<string[] | undefined>>()
  return all(await Promise.all(items.map((item) => location(item, options, cache))))
}

function all(lines: (string | undefined)[]) {
  return lines.every((line) => line !== undefined) ? lines : undefined
}

async function location(item: Json, options: Options, cache: Map<string, Promise<string[] | undefined>>) {
  // LocationLink carries targetUri/targetSelectionRange, Location carries uri/range
  const uri = item.uri ?? item.targetUri
  const start = ((item.range ?? item.targetSelectionRange ?? item.targetRange) as Json | undefined)?.start as
    | Json
    | undefined
  if (typeof uri !== "string" || typeof start?.line !== "number" || typeof start.character !== "number") return undefined
  const file = toPath(uri)
  const head = `${rel(file, options.root)}:${start.line + 1}:${start.character + 1}`
  if (!options.read) return head
  const loaded = cache.get(file) ?? options.read(file).then((text) => text?.split(/\r?\n/))
  cache.set(file, loaded)
  const source = (await loaded)?.[start.line]?.trim()
  return source ? `${head} ${clip(source, MAX_SOURCE)}` : head
}

function symbols(items: Json[], options: Options) {
  return all(items.flatMap((item) => ("location" in item ? flat(item, options) : tree(item, 0))))
}

function tree(item: Json, depth: number): (string | undefined)[] {
  const start = ((item.selectionRange ?? item.range) as Json | undefined)?.start as Json | undefined
  if (typeof item.name !== "string" || typeof start?.line !== "number") return [undefined]
  const children = Array.isArray(item.children) ? item.children.filter(isObject) : []
  return [
    `${"  ".repeat(depth)}${kind(item.kind)} ${item.name} ${start.line + 1}`,
    ...children.flatMap((child) => tree(child, depth + 1)),
  ]
}

function flat(item: Json, options: Options) {
  const loc = item.location as Json | undefined
  const start = (loc?.range as Json | undefined)?.start as Json | undefined
  if (typeof item.name !== "string" || typeof loc?.uri !== "string" || typeof start?.line !== "number") return [undefined]
  return [`${kind(item.kind)} ${item.name} ${rel(toPath(loc.uri), options.root)}:${start.line + 1}`]
}

function callItem(item: unknown, options: Options) {
  if (!isObject(item) || typeof item.name !== "string" || typeof item.uri !== "string") return undefined
  const start = ((item.selectionRange ?? item.range) as Json | undefined)?.start as Json | undefined
  if (typeof start?.line !== "number") return undefined
  return `${item.name} ${kind(item.kind)} ${rel(toPath(item.uri), options.root)}:${start.line + 1}`
}

function hover(items: Json[]) {
  const text = items
    .map((item) => hoverText(item.contents))
    .filter((part) => part.length > 0)
    .join("\n\n")
  if (!text) return undefined
  if (text.length <= MAX_HOVER) return text.split("\n")
  return [...text.slice(0, MAX_HOVER).split("\n"), "... truncated"]
}

function hoverText(contents: unknown): string {
  if (typeof contents === "string") return contents.trim()
  if (Array.isArray(contents)) return contents.map(hoverText).filter(Boolean).join("\n\n")
  if (!isObject(contents) || typeof contents.value !== "string") return ""
  // MarkedString { language, value } needs a fence; MarkupContent already holds markdown or plaintext
  if (typeof contents.language === "string") return "```" + contents.language + "\n" + contents.value.trim() + "\n```"
  return contents.value.trim()
}

function kind(value: unknown) {
  return (typeof value === "number" && KINDS[value]) || "Unknown"
}

function toPath(uri: string) {
  return uri.startsWith("file://") ? fileURLToPath(uri) : uri
}

function rel(file: string, root: string) {
  const relative = path.relative(root, file)
  return relative.startsWith("..") ? file : relative
}

function clip(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export * as ForkLsp from "./lsp"

import { expect, test } from "bun:test"
import { copyCommand, pickImageType } from "../src/clipboard"

test("prefers Wayland clipboard when available", () => {
  expect(copyCommand("linux", true, (name) => name === "wl-copy")).toEqual(["wl-copy"])
})

test("uses osascript on macOS", () => {
  expect(copyCommand("darwin", false, (name) => name === "osascript")).toEqual(["osascript"])
})

test("falls back through X11 clipboard commands", () => {
  expect(copyCommand("linux", true, (name) => name === "xclip")).toEqual(["xclip", "-selection", "clipboard"])
  expect(copyCommand("linux", false, (name) => name === "xsel")).toEqual(["xsel", "--clipboard", "--input"])
})

test("returns undefined when native clipboard is unavailable", () => {
  expect(copyCommand("linux", false, () => false)).toBeUndefined()
})

test("picks the best image format the clipboard offers", () => {
  expect(pickImageType(["text/plain", "image/jpeg", "image/png"])).toBe("image/png")
  expect(pickImageType(["TARGETS", "image/webp\n"])).toBe("image/webp")
  expect(pickImageType(["image/avif"])).toBe("image/avif")
  expect(pickImageType(["text/plain", "UTF8_STRING"])).toBeUndefined()
})

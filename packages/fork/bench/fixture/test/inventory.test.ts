import { beforeEach, expect, test } from "bun:test"
import { addProduct, clearCatalog, reserve } from "../src/inventory"

beforeEach(() => clearCatalog())

test("reserve decrements stock", () => {
  addProduct({ sku: "a", name: "A", price: 1, stock: 2 })
  expect(reserve("a", 2)).toBe(true)
  expect(reserve("a", 1)).toBe(false)
})

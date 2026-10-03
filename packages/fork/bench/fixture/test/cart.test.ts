import { expect, test } from "bun:test"
import { calcTotal, subtotal } from "../src/cart"

const pen = { sku: "pen", name: "Pen", price: 2, stock: 10 }
const book = { sku: "book", name: "Book", price: 10, stock: 3 }

test("subtotal sums price times quantity", () => {
  expect(subtotal([{ product: pen, quantity: 3 }, { product: book, quantity: 1 }])).toBe(16)
})

test("total applies a fractional discount then tax", () => {
  expect(calcTotal([{ product: book, quantity: 2 }], 0.1, 0.2)).toBe(21.6)
})

test("total without discount only adds tax", () => {
  expect(calcTotal([{ product: book, quantity: 1 }], 0, 0.2)).toBe(12)
})

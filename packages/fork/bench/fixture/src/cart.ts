import type { Product } from "./inventory"

export type LineItem = { product: Product; quantity: number }

export function subtotal(items: LineItem[]) {
  return items.reduce((sum, item) => sum + item.product.price * item.quantity, 0)
}

// Discount is a fraction between 0 and 1, applied to the subtotal before tax.
export function calcTotal(items: LineItem[], discount: number, taxRate: number) {
  const base = subtotal(items)
  const discounted = base - discount
  return Math.round(discounted * (1 + taxRate) * 100) / 100
}

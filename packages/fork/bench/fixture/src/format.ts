import { calcTotal, type LineItem } from "./cart"

export function formatPrice(value: number, currency = "EUR") {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency }).format(value)
}

export function receipt(items: LineItem[], discount: number, taxRate: number) {
  const lines = items.map((item) => `${item.quantity} x ${item.product.name}  ${formatPrice(item.product.price * item.quantity)}`)
  return [...lines, `TOTAL  ${formatPrice(calcTotal(items, discount, taxRate))}`].join("\n")
}

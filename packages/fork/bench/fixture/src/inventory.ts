export type Product = { sku: string; name: string; price: number; stock: number }

const catalog = new Map<string, Product>()

export function addProduct(product: Product) {
  if (catalog.has(product.sku)) throw new Error(`duplicate sku ${product.sku}`)
  catalog.set(product.sku, product)
}

export function findProduct(sku: string) {
  return catalog.get(sku)
}

export function reserve(sku: string, quantity: number) {
  const product = catalog.get(sku)
  if (!product) throw new Error(`unknown sku ${sku}`)
  if (product.stock < quantity) return false
  product.stock -= quantity
  return true
}

export function clearCatalog() {
  catalog.clear()
}

export interface Line {
  qty: number;
  price: number;
}

/** Extracted shared helper. (REFERENCE SOLUTION.) */
function subtotal(lines: Line[]): number {
  return lines.reduce((a, l) => a + l.qty * l.price, 0);
}

export function summary(lines: Line[]): string {
  return `subtotal: ${subtotal(lines)}`;
}

export function detailed(lines: Line[]): string {
  const items = lines.map((l) => `${l.qty}x@${l.price}`).join(", ");
  return `${items} = ${subtotal(lines)}`;
}

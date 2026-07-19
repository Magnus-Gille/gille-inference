export interface Line {
  qty: number;
  price: number;
}

// NOTE: `summary` and `detailed` both compute the subtotal with the SAME duplicated reduce.
export function summary(lines: Line[]): string {
  const subtotal = lines.reduce((a, l) => a + l.qty * l.price, 0);
  return `subtotal: ${subtotal}`;
}

export function detailed(lines: Line[]): string {
  const subtotal = lines.reduce((a, l) => a + l.qty * l.price, 0);
  const items = lines.map((l) => `${l.qty}x@${l.price}`).join(", ");
  return `${items} = ${subtotal}`;
}

/** Return page `page` (0-indexed) of `items`, `size` per page. (REFERENCE SOLUTION.) */
export function paginate<T>(items: T[], page: number, size: number): T[] {
  const start = page * size;
  return items.slice(start, start + size);
}

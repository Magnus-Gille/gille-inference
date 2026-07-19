/**
 * Return page `page` (0-indexed) of `items`, `size` items per page.
 * BUG: the slice end is off by one (`+ size + 1`), so adjacent pages overlap by one item.
 */
export function paginate<T>(items: T[], page: number, size: number): T[] {
  const start = page * size;
  return items.slice(start, start + size + 1);
}

import path from "node:path";

export function cachePath(root: string, key: string): string {
  return path.join(root, key);
}

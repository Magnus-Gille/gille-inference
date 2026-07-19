import { isAbsolute, resolve, sep } from "node:path";

export function cachePath(root: string, key: string): string {
  if (key.trim() === "" || isAbsolute(key)) throw new Error("invalid cache key");
  const base = resolve(root);
  const candidate = resolve(base, key);
  if (candidate === base || !candidate.startsWith(base + sep)) throw new Error("cache key escapes root");
  return candidate;
}

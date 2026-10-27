import type { ReactNode } from "react";
import { href, scopePath } from "../lib/router.ts";

export function ScopeLink({ id, children }: { id: string; children?: ReactNode }) {
  const path = scopePath(id);
  return path ? <a href={href(path)}>{children ?? id}</a> : <span>{children ?? id}</span>;
}

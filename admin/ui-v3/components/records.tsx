import { human, int } from "../lib/format.ts";
import { Button } from "./ui.tsx";

export function ChangeList({ d }: { d: any }) {
  const changes: any[] = Array.isArray(d?.changes) ? d.changes : [];
  if (!changes.length) return <span className="muted">{d?.code ? human(d.code) : "—"}</span>;
  return (
    <ul className="change-list">
      {changes.slice(0, 4).map((c, i) => <li key={i}><code>{String(c.path).split(".").slice(-3).join(".")}</code> <span className="diff-before">{JSON.stringify(c.before)}</span> → <span className="diff-after">{JSON.stringify(c.after)}</span></li>)}
      {changes.length > 4 && <li className="muted">+{changes.length - 4} more</li>}
    </ul>
  );
}

export function PagerLite({ page, onPage }: { page: any; onPage: (o: number) => void }) {
  return (
    <nav className="pager" aria-label="Pages">
      <span className="muted">{page.returned ? `${page.offset + 1}–${page.offset + page.returned}` : 0}{page.matched !== null ? ` of ${int(page.matched)}` : ""}</span>
      <div className="pager-buttons">
        <Button size="small" disabled={page.offset === 0} onClick={() => onPage(Math.max(0, page.offset - page.limit))}>Previous</Button>
        <Button size="small" disabled={page.nextOffset === null} onClick={() => onPage(page.nextOffset)}>Next</Button>
      </div>
    </nav>
  );
}

import { useEffect, useState } from "react";
import { useQuery } from "../lib/api.ts";
import { suggestPath } from "../lib/user-tags.ts";

// A text input that suggests saved user tags while typing (GET /api/user-tags?search=), through the
// browser's own suggestion list, so keyboard and screen-reader behaviour is the platform's.
export function TagInput({ id, describedBy, value, onChange, invalid, placeholder }: {
  id: string; describedBy?: string; value: string; onChange: (value: string) => void; invalid?: boolean; placeholder?: string;
}) {
  const [typed, setTyped] = useState(value);
  useEffect(() => { const t = setTimeout(() => setTyped(value), 200); return () => clearTimeout(t); }, [value]);
  const suggestions = useQuery<{ tags: string[] }>(suggestPath(typed));
  const listId = `${id}-saved-tags`;
  return (
    <>
      <input id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} className="input mono" list={listId} value={value} maxLength={64}
        placeholder={placeholder} autoComplete="off" spellCheck={false} onChange={(e) => onChange(e.target.value.trim())} />
      <datalist id={listId}>{(suggestions.data?.tags ?? []).map((t) => <option key={t} value={t} />)}</datalist>
      {suggestions.error ? <span className="muted small" role="status">Saved tags can't be suggested right now; you can still type a tag.</span> : null}
    </>
  );
}

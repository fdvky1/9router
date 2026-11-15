"use client";

import PropTypes from "prop-types";
import {
  CUSTOM_HEADER_NAME_RE,
  BLOCKED_CUSTOM_HEADERS,
} from "@/shared/utils/customHeaders";

export default function CustomHeadersEditor({
  rows,
  setRows,
  expanded,
  setExpanded,
  title = "Custom Headers",
  hint = "Optional upstream headers sent with every request (e.g. CF-Access-Client-Id, HTTP-Referer).",
}) {
  const setRow = (i, field, value) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)));
  };

  const hasConfiguredHeaders = rows.some((r) => r.name?.trim() && r.value?.trim());

  return (
    <div className="rounded-lg border border-border p-3 bg-card">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between text-left"
      >
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary text-[18px]">tune</span>
          <span className="text-sm font-medium">{title}</span>
          {hasConfiguredHeaders && (
            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
              {rows.filter((r) => r.name?.trim()).length} set
            </span>
          )}
        </div>
        <span className="material-symbols-outlined text-text-muted text-[18px]">
          {expanded ? "expand_less" : "expand_more"}
        </span>
      </button>

      {expanded && (
        <div className="mt-3 border-t border-border pt-3">
          {hint && <p className="mb-2 text-xs text-text-muted">{hint}</p>}
          <div className="flex flex-col gap-2">
            {rows.map((row, i) => {
              const name = row.name.trim();
              const isInvalidName = name && !CUSTOM_HEADER_NAME_RE.test(name);
              const isBlocked = name && BLOCKED_CUSTOM_HEADERS.has(name.toLowerCase());
              return (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={row.name}
                    onChange={(e) => setRow(i, "name", e.target.value)}
                    placeholder="Header-Name"
                    spellCheck={false}
                    className={`w-40 sm:w-44 rounded-md border bg-background px-2 py-1.5 text-xs sm:text-sm focus:border-primary focus:outline-none ${
                      isInvalidName || isBlocked ? "border-red-500" : "border-border"
                    }`}
                  />
                  <input
                    value={row.value}
                    onChange={(e) => setRow(i, "value", e.target.value)}
                    placeholder="Value"
                    spellCheck={false}
                    className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs sm:text-sm focus:border-primary focus:outline-none"
                  />
                  <button
                    type="button"
                    title="Remove header"
                    onClick={() =>
                      setRows((prev) =>
                        prev.length > 1 ? prev.filter((_, idx) => idx !== i) : [{ name: "", value: "" }]
                      )
                    }
                    className="shrink-0 text-text-muted hover:text-red-500"
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                  </button>
                </div>
              );
            })}
          </div>

          <div className="mt-2.5">
            <button
              type="button"
              onClick={() => setRows((prev) => [...prev, { name: "", value: "" }])}
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <span className="material-symbols-outlined text-[16px]">add</span>
              Add header
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

CustomHeadersEditor.propTypes = {
  rows: PropTypes.arrayOf(
    PropTypes.shape({
      name: PropTypes.string,
      value: PropTypes.string,
    })
  ).isRequired,
  setRows: PropTypes.func.isRequired,
  expanded: PropTypes.bool.isRequired,
  setExpanded: PropTypes.func.isRequired,
  title: PropTypes.string,
  hint: PropTypes.string,
};

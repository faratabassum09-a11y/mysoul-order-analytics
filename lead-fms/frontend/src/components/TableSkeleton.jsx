import React from "react";

// Placeholder rows shown while a table's data is loading, so the page
// never flashes an empty table or a bare "Loading..." line — the column
// structure is already visible, only the content is still arriving.
export default function TableSkeleton({ columns, rows = 8 }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr className="skeleton-row" key={r}>
          {Array.from({ length: columns }).map((__, c) => (
            <td key={c}>
              <span className="skeleton-bar" style={{ width: `${55 + ((r * 7 + c * 13) % 40)}%` }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

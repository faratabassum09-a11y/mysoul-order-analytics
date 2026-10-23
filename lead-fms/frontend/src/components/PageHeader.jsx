import React from "react";

export default function PageHeader({ title, subtitle, meta }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="subtitle">{subtitle}</p>}
      </div>
      {meta && <div className="page-header-meta">{meta}</div>}
    </div>
  );
}

import React from "react";

// The MySoulSchool circle logo (public/mysoulschool-logo.png).
export function SchoolMark({ size = 36, className = "" }) {
  return <img src="/mysoulschool-logo.png" width={size} height={size} alt="MySoulSchool" className={"school-mark " + className} draggable="false" />;
}

// Website lockup shown at the very top: circle mark + "mysoulschool" wordmark

export default function SchoolBrand({ size = 34, compact = false, tone = "dark", className = "" }) {
  return (
    <div className={`school-brand school-brand-${tone} ${className}`}>
      <SchoolMark size={size} />
      {!compact && (
        <div className="school-brand-text">
          <span className="school-wordmark"><b>mysoul</b>school</span>
        </div>
      )}
    </div>
  );
}

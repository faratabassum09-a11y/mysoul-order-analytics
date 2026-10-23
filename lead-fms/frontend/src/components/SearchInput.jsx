import React from "react";

export default function SearchInput({ value, onChange, placeholder }) {
  return (
    <div className="search-input">
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="9" cy="9" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <line x1="13.6" y1="13.6" x2="18" y2="18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button
          type="button"
          className="search-clear"
          aria-label="Clear search"
          onClick={() => onChange("")}
        >
          ×
        </button>
      )}
    </div>
  );
}

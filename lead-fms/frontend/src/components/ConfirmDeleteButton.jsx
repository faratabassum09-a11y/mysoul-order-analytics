import React, { useEffect, useRef, useState } from "react";

// Click once to arm ("Delete" -> "Confirm?"), click again within 3s to
// actually run onConfirm. Clicking elsewhere or letting it time out
// disarms it. Keeps deletion deliberate without a jarring native confirm().
export default function ConfirmDeleteButton({ onConfirm, label = "Delete", confirmLabel = "Confirm?" }) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleClick = () => {
    if (!armed) {
      setArmed(true);
      timerRef.current = setTimeout(() => setArmed(false), 3000);
      return;
    }
    clearTimeout(timerRef.current);
    setArmed(false);
    onConfirm();
  };

  return (
    <button
      type="button"
      className={"link-btn danger" + (armed ? " confirming" : "")}
      onClick={handleClick}
      onBlur={() => setArmed(false)}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

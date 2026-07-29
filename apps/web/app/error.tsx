"use client";

import { useEffect } from "react";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log to console for developers but never expose to the user.
    console.error("[checkout] unexpected error:", error);
  }, [error]);

  return (
    <main className="shell shell--narrow">
      <div className="panel checkout">
        <div className="error-icon" aria-hidden>
          ⚡
        </div>
        <div className="error-heading">Something went wrong</div>
        <p className="muted" style={{ marginTop: 8 }}>
          An unexpected error occurred. Please try again.
        </p>
        <button className="btn btn--primary" style={{ marginTop: 20 }} onClick={reset}>
          Try again
        </button>
      </div>
    </main>
  );
}

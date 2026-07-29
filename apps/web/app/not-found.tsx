import Link from "next/link";

export default function NotFoundPage() {
  return (
    <main className="shell shell--narrow">
      <div className="panel checkout">
        <p className="title">Page not found</p>
        <p className="muted">
          The page you&apos;re looking for doesn&apos;t exist. It may have been removed or the
          address is wrong.
        </p>
        <div style={{ marginTop: 20 }}>
          <Link className="btn btn--ghost" href="/">
            Back to dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}

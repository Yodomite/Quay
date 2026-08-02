import Link from "next/link";
import { api, CheckoutError } from "../../../lib/api";
import CheckoutClient from "../../components/CheckoutClient";

export default async function PayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let data;
  try {
    data = await api.getLink(id);
  } catch (err) {
    const isUnreachable = err instanceof CheckoutError && err.code === "unreachable";

    return (
      <main className="shell shell--narrow">
        <div className="panel checkout">
          {isUnreachable ? (
            <>
              <div className="error-icon" aria-hidden>⚡</div>
              <p className="title">Unable to load this payment link</p>
              <p className="muted">
                We can&apos;t reach the payment service right now. Please refresh the page or try
                again in a moment.
              </p>
            </>
          ) : (
            <>
              <p className="title">Payment link not found</p>
              <p className="muted">This link may have been removed, or the id is wrong.</p>
            </>
          )}
          <div style={{ marginTop: 20, display: "flex", gap: 12, justifyContent: "center" }}>
            <Link className="btn btn--ghost" href={`/pay/${id}`}>
              Refresh
            </Link>
            <Link className="btn btn--ghost" href="/">
              Back to dashboard
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="shell shell--narrow">
      <header className="masthead">
        <h1>Stellar Checkout</h1>
        <span className="net mono">{data.link.asset.code}</span>
      </header>
      <div className="panel">
        <CheckoutClient initial={data} />
      </div>
    </main>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { api, CheckoutError, describeError, type PaymentLink } from "../../lib/api";

// Mirrors the API's OFFRAMP setting (see .env.example) so this button never
// claims a real payout when the backend is still running MockAnchorOffRamp.
const OFFRAMP_CURRENCY = process.env.NEXT_PUBLIC_OFFRAMP_CURRENCY ?? "NGN";
const OFFRAMP_IS_MOCK = (process.env.NEXT_PUBLIC_OFFRAMP_MODE ?? "mock") !== "testanchor";
const CASH_OUT_LABEL = OFFRAMP_IS_MOCK
  ? `Cash out to ${OFFRAMP_CURRENCY} (simulated)`
  : `Cash out to ${OFFRAMP_CURRENCY}`;

// ── Small helpers ───────────────────────────────────────────────────────────

function StatusPill({ status }: { status: string }) {
  const label = status.replace("offramp_", "off-ramp ").replace("_", " ");
  return <span className={`pill pill--${status}`}>{label}</span>;
}

function amountLabel(link: PaymentLink): string {
  return `${link.amount} ${link.asset.code}`;
}

function SkeletonTable() {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Title</th>
          <th>Amount</th>
          <th>Status</th>
          <th className="hide-sm">Reference</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {[1, 2, 3].map((i) => (
          <tr key={i}>
            <td>
              <span className="skeleton skeleton--w140" />
            </td>
            <td className="amt">
              <span className="skeleton skeleton--w80" />
            </td>
            <td>
              <span className="skeleton skeleton--w60" />
            </td>
            <td className="hide-sm">
              <span className="skeleton skeleton--w120" />
            </td>
            <td style={{ textAlign: "right" }}>
              <span className="skeleton skeleton--w90 skeleton--right" />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ErrorBanner({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="error-banner">
      <p className="error-banner__text">{message}</p>
      <button className="btn btn--ghost" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

interface TableProps {
  links: PaymentLink[];
  copied: string | null;
  onCopy: (id: string) => void;
  onCashOut: (id: string) => void;
}

function LinksTable({ links, copied, onCopy, onCashOut }: TableProps) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Title</th>
          <th>Amount</th>
          <th>Status</th>
          <th className="hide-sm">Reference</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {links.map((link) => (
          <tr key={link.id}>
            <td>{link.title}</td>
            <td className="amt">{amountLabel(link)}</td>
            <td>
              <StatusPill status={link.status} />
            </td>
            <td className="hide-sm">
              <span className="mono muted">{link.reference}</span>
            </td>
            <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
              <button className="linkbtn" onClick={() => onCopy(link.id)}>
                {copied === link.id ? "Copied" : "Copy link"}
              </button>
              {link.status === "paid" && (
                <>
                  {" · "}
                  <button className="linkbtn" onClick={() => onCashOut(link.id)}>
                    {CASH_OUT_LABEL}
                  </button>
                </>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Component ───────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [links, setLinks] = useState<PaymentLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Create-link form
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [assetCode, setAssetCode] = useState<"USDC" | "XLM">("USDC");
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { links: fresh } = await api.listLinks();
      setLinks(fresh);
      setFetchError(null);
    } catch (e) {
      const msg =
        e instanceof CheckoutError
          ? describeError(e)
          : "Failed to load links. Please try again.";
      // If we already have data, keep showing it with a banner on top.
      setFetchError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 5_000);
    return () => clearInterval(t);
  }, [refresh]);

  async function create() {
    setActionError(null);
    if (!title.trim() || !amount.trim()) {
      setActionError("Add a title and an amount.");
      return;
    }
    setCreating(true);
    try {
      const { link } = await api.createLink({
        title: title.trim(),
        amount: amount.trim(),
        assetCode,
      });
      setTitle("");
      setAmount("");
      setLinks((prev) => [link, ...prev]);
    } catch (e) {
      setActionError(
        e instanceof CheckoutError
          ? describeError(e)
          : "Failed to create the payment link. Please try again.",
      );
    } finally {
      setCreating(false);
    }
  }

  async function copyCheckout(id: string) {
    const url = `${window.location.origin}/pay/${id}`;
    await navigator.clipboard.writeText(url);
    setCopied(id);
    setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
  }

  async function cashOut(id: string) {
    setActionError(null);
    try {
      await api.cashOut(id, OFFRAMP_CURRENCY);
      await refresh();
    } catch (e) {
      setActionError(
        e instanceof CheckoutError ? describeError(e) : "Cash-out failed. Please try again.",
      );
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <>
      <section className="panel">
        <h2>New payment link</h2>
        <div className="field">
          <label htmlFor="title">What is this for</label>
          <input
            id="title"
            placeholder="Invoice #1024 — 2x ceramic mug"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor="amount">Amount</label>
            <input
              id="amount"
              className="mono"
              inputMode="decimal"
              placeholder="25.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="asset">Asset</label>
            <select
              id="asset"
              value={assetCode}
              onChange={(e) => setAssetCode(e.target.value as "USDC" | "XLM")}
            >
              <option value="USDC">USDC</option>
              <option value="XLM">XLM</option>
            </select>
          </div>
        </div>
        <button className="btn btn--primary btn--block" onClick={create} disabled={creating}>
          {creating ? "Creating…" : "Create link"}
        </button>
        {actionError && <div className="err">{actionError}</div>}
      </section>

      <section className="panel">
        <h2>Links</h2>

        {loading && <SkeletonTable />}

        {!loading && fetchError && links.length === 0 && (
          <ErrorBanner message={fetchError} onRetry={refresh} />
        )}

        {!loading && fetchError && links.length > 0 && (
          <>
            <ErrorBanner message={fetchError} onRetry={refresh} />
            <div style={{ marginTop: 16 }}>
              <LinksTable links={links} copied={copied} onCopy={copyCheckout} onCashOut={cashOut} />
            </div>
          </>
        )}

        {!loading && !fetchError && links.length === 0 && (
          <div className="empty">No links yet. Create one above to get a checkout page.</div>
        )}

        {!loading && !fetchError && links.length > 0 && (
          <LinksTable links={links} copied={copied} onCopy={copyCheckout} onCashOut={cashOut} />
        )}
      </section>
    </>
  );
}

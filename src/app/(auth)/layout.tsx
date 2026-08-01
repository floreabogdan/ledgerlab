import type { ReactNode } from "react";
import Link from "next/link";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="auth-shell">
      <section className="auth-panel">
        <Link className="auth-brand" href="/" aria-label="LedgerLab home">
          <span className="brand-mark" aria-hidden="true">L</span>
          <span className="brand-name">LedgerLab</span>
        </Link>
        {children}
        <p className="auth-footnote">Local workspace · multi-currency · your regional settings</p>
      </section>
      <aside className="auth-aside" aria-label="About LedgerLab">
        <div className="auth-aside-content">
          <span className="auth-aside-label">A clearer monthly picture</span>
          <h2>Actual money, future obligations, one calm workspace.</h2>
          <p>
            Track what happened, prepare what comes next, and keep projections clearly separated from real balances.
          </p>
          <div className="auth-preview" aria-label="Empty workspace preview">
            <div className="auth-preview-item"><span>Cash available</span><strong>$0.00</strong></div>
            <div className="auth-preview-item"><span>Due soon</span><strong>0 payments</strong></div>
            <div className="auth-preview-item"><span>Month forecast</span><strong>Not planned</strong></div>
          </div>
        </div>
      </aside>
    </main>
  );
}

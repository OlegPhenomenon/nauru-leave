export default function Help() {
  return (
    <div className="panel" style={{ maxWidth: '46rem' }}>
      <h1>How to use Nauru Leave Desk</h1>

      <h2>Requesting leave</h2>
      <ol>
        <li>Open <strong>New request</strong>, pick a leave type and your dates. For half days,
          choose “Morning” or “Afternoon” where the leave type allows it.</li>
        <li>The preview shows exactly which days count, how much time each takes, and which year’s
          balance it comes from. Days off and holidays inside your range are not counted.</li>
        <li>Press <strong>Submit for approval</strong>. The days are reserved from your balance while
          the request travels: manager recommendation → HR check → final decision.</li>
        <li>If you need to attach a document (for example a certificate), press
          <strong> Save draft</strong> first, upload the file on the request page, then submit.</li>
      </ol>

      <h2>What the statuses mean</h2>
      <ul>
        <li><strong>Draft</strong> — saved but not sent; it reserves nothing.</li>
        <li><strong>Submitted / Under review</strong> — in the approval route; days are reserved.</li>
        <li><strong>Needs information</strong> — someone asked you a question; answer it on the
          request page, or change the dates there (changes restart the route).</li>
        <li><strong>Approved</strong> — final decision made; the time is recorded in your ledger.</li>
        <li><strong>Rejected / Withdrawn / Cancelled</strong> — closed; the reservation is released.</li>
      </ul>
      <p>Separately, a request can be <em>upcoming</em>, <em>in progress</em> or
        <em> period ended</em> — that is about the dates, not the decision.</p>

      <h2>How your balance is calculated</h2>
      <p>
        <strong>Available = ledger − reservations.</strong> The ledger adds your opening balance,
        accruals and corrections, and subtracts approved leave at the moment it is approved.
        Reservations are held by requests that are still being decided — drafts do not reserve.
        Follow the “How is this calculated?” link on My leave to see every entry with a running total.
      </p>

      <h2>After approval</h2>
      <ul>
        <li>Need different dates? Use <strong>Request amendment</strong> — the approved leave stays in
          force until the amendment is decided.</li>
        <li>Need to give days back? Use <strong>Request cancellation</strong> for all or part of the
          range. Past days are corrected by HR, not cancelled.</li>
        <li>The printable card on the request page is a record of the decision — it is not a
          government electronic signature.</li>
      </ul>
    </div>
  );
}

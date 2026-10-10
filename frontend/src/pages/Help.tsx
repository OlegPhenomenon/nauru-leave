import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { PageHeader } from '../components/ui';

// One help question. A native <details> with the same classes as the shared
// Details component, but openable from a URL hash (#request, #answer…).
// `anchors` are extra hash targets inside the answer that open this question.
function Qa({
  id,
  q,
  anchors = [],
  children,
}: {
  id: string;
  q: string;
  anchors?: string[] | undefined;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() =>
    [id, ...anchors].includes(window.location.hash.slice(1)),
  );

  useEffect(() => {
    const hit = () => {
      const h = window.location.hash.slice(1);
      return [id, ...anchors].includes(h) ? h : null;
    };
    const target = hit();
    if (target) document.getElementById(target)?.scrollIntoView();
    const onHash = () => {
      const t = hit();
      if (t) {
        setOpen(true);
        document.getElementById(t)?.scrollIntoView();
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [id, anchors]);

  return (
    <details
      id={id}
      className="disclosure"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>{q}</summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

export default function Help() {
  return (
    <div className="stack">
      <PageHeader title="Help" />

      <Qa id="request" q="How do I request leave?" anchors={['certificate']}>
        <ol>
          <li>
            Press <strong>Request leave</strong> at the top of{' '}
            <Link to="/my">My leave</Link>.
          </li>
          <li>
            Pick the leave type and your start and end dates. For a single day you can
            choose morning or afternoon instead of a full day where the type allows it.
            The summary under the dates shows how many working days it will use.
          </li>
          <li id="certificate">
            Some leave types need a document (for example a certificate) — the form
            shows a document area when that applies. The file uploads when your
            request is created.
          </li>
          <li>
            Press <strong>Send request</strong>. Your days are held while it is
            decided — your manager and HR can see it. Or press{' '}
            <strong>Save as draft</strong> and finish it later from My leave.
          </li>
        </ol>
      </Qa>

      <Qa id="answer" q="How do I answer a question?">
        <p>
          If your manager or HR asks for more information, an{' '}
          <strong>Action needed</strong> card appears at the top of{' '}
          <Link to="/my">My leave</Link>. Type your answer there and press{' '}
          <strong>Send answer</strong>. If you would rather move the leave, press{' '}
          <strong>Change dates instead</strong> on the same card — that opens the
          request page where you can change it.
        </p>
      </Qa>

      <Qa id="change" q="How do I change or cancel leave?">
        <p>
          Open the request from <Link to="/my">My leave</Link> and choose{' '}
          <strong>Change dates</strong> or <strong>Cancellation of days</strong> on
          the request page. This creates a change that is approved like a normal
          request — the original leave stays in force until the change is decided.
          For days that have already happened, ask HR to correct the record.
        </p>
      </Qa>

      <Qa id="statuses" q="What do the statuses mean?">
        <ul>
          <li>
            <strong>Draft</strong> — saved but not sent yet.
          </li>
          <li>
            <strong>Waiting</strong> — being decided. The days are already held for
            you so nobody can take them.
          </li>
          <li>
            <strong>Needs an answer</strong> — someone asked you a question; see
            “How do I answer a question?”.
          </li>
          <li>
            <strong>Approved</strong> — decided; the leave is booked.
          </li>
          <li>
            <strong>Refused</strong> — not approved; the reason is on the request
            page.
          </li>
          <li>
            <strong>Withdrawn / Cancelled</strong> — closed, and the held days are
            given back.
          </li>
        </ul>
      </Qa>

      <Qa id="balance" q="How are my days left worked out?">
        <p>
          <strong>Days left</strong> on My leave is what you can still use: your
          allowance for the year, minus leave already approved and anything still
          waiting for a decision. Press <strong>How is this worked out?</strong> on
          any line to see the full story — every addition, every day used, and what
          is on hold.
        </p>
      </Qa>
    </div>
  );
}

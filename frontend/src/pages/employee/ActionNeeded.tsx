// "Action needed" card for My leave: shows the question a reviewer asked
// on a needs_information request and answers it inline via /respond.

import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError, newIdempotencyKey, post } from '../../api/client';
import type { RequestDetail, RequestSummary } from '../../api/types';
import { ErrBox, Loading, useToast } from '../../components/ui';
import { fmtRange } from '../../lib/format';
import { useApi } from '../../lib/useApi';

export function ActionNeeded({
  request,
  onDone,
  primary = true,
}: {
  request: RequestSummary;
  onDone: () => void;
  primary?: boolean;
}) {
  const detail = useApi(() => api<RequestDetail>(`/requests/${request.id}`), [request.id]);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const toast = useToast();
  // One key per card so a retry after a dropped connection replays safely.
  const key = useRef(newIdempotencyKey());

  const question = [...(detail.data?.messages ?? [])]
    .reverse()
    .find((m) => m.kind === 'question');

  async function send() {
    if (!detail.data) return;
    setBusy(true);
    setErr(null);
    try {
      await post(
        `/requests/${request.id}/respond`,
        { expected_version: detail.data.version, body: body.trim() },
        key.current,
      );
      toast('Answer sent.');
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e)));
    } finally {
      setBusy(false);
    }
  }

  const where = `${request.leave_type_name} ${fmtRange(request.start_date, request.end_date)}`;

  return (
    <section className="action-card" aria-label="Action needed">
      <h2>Action needed</h2>
      <p className="muted small">
        <Link to={`/requests/${request.id}`}>{where}</Link>
      </p>
      {detail.loading ? <Loading label="Loading the question…" /> : null}
      {detail.error ? <ErrBox error={detail.error} /> : null}
      {detail.data ? (
        <>
          <p className="q">
            <strong>{question?.author?.display_name ?? 'HR'} asked:</strong> “
            {question?.body ?? 'Please add the missing information.'}”
          </p>
          <label className="field">
            <span className="field-label">Your answer</span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Type your answer…"
            />
          </label>
          {err ? <ErrBox error={err} /> : null}
          <div className="btn-row">
            <button
              type="button"
              className={primary ? 'btn' : 'btn btn-secondary'}
              disabled={busy || !body.trim()}
              onClick={() => void send()}
            >
              {busy ? 'Sending…' : 'Send answer'}
            </button>
            <Link className="btn btn-ghost" to={`/requests/${request.id}`}>
              Change dates instead
            </Link>
          </div>
        </>
      ) : null}
    </section>
  );
}

import { useLayoutEffect, useRef, useState } from 'react';
import type { ExportSnapshot, PdfArtifact, PdfUiServices } from './exportTypes';

type Session = { active: boolean; busy: boolean; key: string; services: PdfUiServices };
type Ready = { session: Session; snapshot: ExportSnapshot; artifact: PdfArtifact; warning: string };
export function usePdfExport(
  snapshot: ExportSnapshot,
  sessionKey: string,
  services: PdfUiServices,
) {
  const [ready, setReady] = useState<Ready | null>(null);
  const [stage, setStage] = useState<'idle' | 'preparing' | 'sharing' | 'previewing'>('idle');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const binding = useRef<Session | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const latest = useRef({ sessionKey, services });
  latest.current = { sessionKey, services };
  useLayoutEffect(() => {
    const session = { active: true, busy: false, key: sessionKey, services };
    binding.current = session;
    setReady(null);
    setStage('idle');
    setMessage('');
    setError('');
    return () => {
      session.active = false;
      if (binding.current === session) binding.current = null;
    };
  }, [sessionKey, services]);
  const isCurrent = (session: Session, captured: ExportSnapshot) =>
    session.active &&
    binding.current === session &&
    snapshotRef.current === captured &&
    session.key === sessionKey &&
    session.services === services &&
    latest.current.sessionKey === sessionKey &&
    latest.current.services === services;
  const visible = ready?.snapshot === snapshot && isCurrent(ready.session, snapshot) ? ready : null;
  const changed = ready !== null && !visible;

  const prepare = async () => {
    const session = binding.current;
    if (!session || !isCurrent(session, snapshot) || session.busy) return;
    session.busy = true;
    const captured = snapshot;
    setStage('preparing');
    setError('');
    setMessage('');
    setReady(null);
    try {
      const result = await services.prepare(captured);
      if (isCurrent(session, captured)) {
        setReady({
          session,
          snapshot: captured,
          artifact: result.artifact,
          warning: result.warning ?? '',
        });
        setMessage('PDF created on this device. Review it before sharing.');
      }
    } catch (cause) {
      if (isCurrent(session, captured))
        setError(
          cause instanceof Error
            ? cause.message
            : 'The PDF could not be prepared. Check the selected details and try again.',
        );
    } finally {
      session.busy = false;
      if (session.active && binding.current === session) setStage('idle');
    }
  };

  const request = async (kind: 'share' | 'preview') => {
    const session = binding.current;
    if (
      !session ||
      !isCurrent(session, snapshot) ||
      session.busy ||
      !visible ||
      (kind === 'preview' && !services.preview)
    )
      return;
    session.busy = true;
    const captured = snapshot;
    const artifact = visible.artifact;
    setStage(kind === 'share' ? 'sharing' : 'previewing');
    setError('');
    setMessage('');
    try {
      const result =
        kind === 'share' ? await services.share(artifact) : await services.preview!(artifact);
      if (isCurrent(session, captured))
        setMessage(
          result.status === 'unavailable'
            ? `${kind === 'share' ? 'Sharing' : 'PDF preview / printing'} is unavailable here. Your PDF is still ready.`
            : kind === 'share'
              ? 'PDF is ready. You can share it again.'
              : 'PDF is ready. Preview / print was requested.',
        );
    } catch (cause) {
      if (isCurrent(session, captured)) {
        if (
          cause &&
          typeof cause === 'object' &&
          'code' in cause &&
          cause.code === 'ARTIFACT_UNAVAILABLE'
        ) {
          setReady(null);
          setError(
            'This PDF is no longer available. Create it again before previewing or sharing.',
          );
        } else {
          setError(
            `${kind === 'share' ? 'Sharing' : 'Preview / print'} could not be confirmed. Try again, or create a new PDF.`,
          );
        }
      }
    } finally {
      session.busy = false;
      if (session.active && binding.current === session) setStage('idle');
    }
  };
  return {
    artifact: visible?.artifact ?? null,
    warning: visible?.warning ?? '',
    stage,
    busy: stage !== 'idle',
    message: changed ? 'Export options changed. Create a new PDF with this selection.' : message,
    error: changed ? '' : error,
    prepare,
    share: () => request('share'),
    preview: services.preview ? () => request('preview') : undefined,
  };
}

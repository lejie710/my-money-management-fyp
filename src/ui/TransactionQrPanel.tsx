import React, { useMemo, useState } from 'react';
import { Text, View, useWindowDimensions } from 'react-native';
import {
  buildTransactionQr,
  DEFAULT_CONTEXT_SELECTION,
  selectTransactionExportSnapshot,
  type ContextSelection,
  type QrPayloadResult,
  type TransactionExportSource,
} from '../core/exports';
import { formatMoney } from '../core/model';
import { Action, FormError } from './components';
import { ExportContextOptions, SelectedExportDetails } from './ExportContextOptions';
import type { QrRenderProps, RenderTransactionQr } from './exportTypes';
import { ui } from './theme';

class QrBoundary extends React.Component<
  { children: React.ReactNode; onError: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function QrContent({
  renderQr,
  options,
}: {
  renderQr: RenderTransactionQr;
  options: QrRenderProps;
}) {
  return renderQr(options);
}

export function TransactionQrPanel({
  source,
  renderQr,
}: {
  source: TransactionExportSource;
  renderQr: RenderTransactionQr;
}) {
  const [selection, setSelection] = useState<ContextSelection>(() => ({
    ...DEFAULT_CONTEXT_SELECTION,
  }));
  const [result, setResult] = useState<QrPayloadResult | null>(null);
  const [error, setError] = useState('');
  const { width } = useWindowDimensions();
  const [measured, setMeasured] = useState<number | null>(null);
  const snapshot = useMemo(
    () => selectTransactionExportSnapshot(source, selection),
    [source, selection],
  );
  const outerSize = Math.max(1, Math.min(360, measured ?? Math.max(1, width - 72)));
  const codeSize = Math.floor(outerSize / 1.4);
  const show = (options = selection) => {
    setError('');
    try {
      setResult(
        buildTransactionQr(selectTransactionExportSnapshot(source, options), {
          notes: options.notes,
          withPerson: options.withPerson,
          location: options.location,
        }),
      );
    } catch {
      setResult(null);
      setError('This summary could not be encoded. Review the selected details or use PDF.');
    }
  };
  const encodingFailed = () =>
    setError(
      'The QR code could not be drawn. Try showing it again or use the readable summary and PDF.',
    );
  return (
    <View style={ui.divider}>
      <Text style={ui.heading} accessibilityRole="header">
        Transaction summary QR
      </Text>
      <Text style={[ui.hint, ui.smallGap]}>
        Anyone who scans the visible code can read its included details. It is a transaction
        summary, not a payment request. Photos are never included.
      </Text>
      <ExportContextOptions
        source={source}
        selection={selection}
        qr
        onChange={(next) => {
          setSelection(next);
          setResult(null);
          setError('');
        }}
      />
      <Text selectable style={[ui.body, ui.smallGap]} testID="qr-readable-summary">
        {source.title}
        {'\n'}
        {source.date} · {source.categoryName}
        {'\n'}
        {source.type === 'debt'
          ? 'Debt payment'
          : source.type === 'income'
            ? 'Income'
            : 'Expense'}{' '}
        · {formatMoney(source.amountMinor, source.currency)}
      </Text>
      <SelectedExportDetails snapshot={snapshot} qr />
      <View style={ui.smallGap}>
        <Action
          secondary
          label={result?.ok && !error ? 'Hide QR code' : 'Show QR code'}
          onPress={() => {
            if (result?.ok && !error) {
              setResult(null);
              setError('');
            } else show();
          }}
          testID="toggle-transaction-qr"
        />
      </View>
      {result && !result.ok ? (
        <View style={ui.smallGap}>
          <Text style={ui.body} testID="qr-too-large">
            The selected text is too long for one code. Choose fewer details or create a PDF; no
            text has been shortened.
          </Text>
          <View style={ui.smallGap}>
            <Action
              secondary
              label="Show summary QR"
              onPress={() => {
                const summary = { ...DEFAULT_CONTEXT_SELECTION };
                setSelection(summary);
                show(summary);
              }}
              testID="qr-show-summary"
            />
          </View>
        </View>
      ) : null}
      {result?.ok && !error ? (
        <View
          style={[ui.gap, { width: '100%', alignItems: 'center' }]}
          onLayout={(event) => {
            const next = event.nativeEvent.layout.width;
            if (Number.isFinite(next) && next > 0) setMeasured(next);
          }}
          testID="transaction-qr-panel"
        >
          <View
            style={{ backgroundColor: '#FFFFFF', alignSelf: 'center' }}
            accessibilityLabel="QR code for the transaction summary displayed above"
          >
            <QrBoundary onError={encodingFailed}>
              <QrContent
                renderQr={renderQr}
                options={{
                  value: result.payload,
                  size: codeSize,
                  quietZone: codeSize / 5,
                  ecl: 'M',
                  color: '#000000',
                  backgroundColor: '#FFFFFF',
                  onError: encodingFailed,
                }}
              />
            </QrBoundary>
          </View>
        </View>
      ) : null}
      <FormError message={error} testID="transaction-qr-error" />
    </View>
  );
}

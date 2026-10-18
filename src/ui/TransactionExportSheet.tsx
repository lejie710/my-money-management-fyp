import React, { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import {
  DEFAULT_CONTEXT_SELECTION,
  selectTransactionExportSnapshot,
  type ContextSelection,
  type TransactionExportSource,
} from '../core/exports';
import { formatMoney } from '../core/model';
import { Sheet } from './components';
import { ExportContextOptions, SelectedExportDetails } from './ExportContextOptions';
import { PdfExportActions } from './PdfExportActions';
import { TransactionQrPanel } from './TransactionQrPanel';
import { usePdfExport } from './usePdfExport';
import type { PdfUiServices, RenderTransactionQr } from './exportTypes';
import { ui } from './theme';

type Props = {
  source: TransactionExportSource;
  sessionKey: string;
  services: PdfUiServices;
  renderQr: RenderTransactionQr;
  onClose: () => void;
};

export function TransactionExportSheet(props: Props) {
  return <TransactionExportContent key={props.sessionKey} {...props} />;
}

function TransactionExportContent({ source, sessionKey, services, renderQr, onClose }: Props) {
  const [selection, setSelection] = useState<ContextSelection>(() => ({
    ...DEFAULT_CONTEXT_SELECTION,
  }));
  const snapshot = useMemo(
    () => selectTransactionExportSnapshot(source, selection),
    [source, selection],
  );
  const pdf = usePdfExport(snapshot, sessionKey, services);
  return (
    <Sheet title="Details & share" onClose={onClose}>
      <Text selectable style={ui.heading} testID="export-transaction-title">
        {source.title}
      </Text>
      <Text selectable style={[ui.body, ui.smallGap]} testID="export-transaction-summary">
        {source.type === 'debt' ? 'Debt payment' : source.type === 'income' ? 'Income' : 'Expense'}{' '}
        · {formatMoney(source.amountMinor, source.currency)}
        {'\n'}
        {source.categoryName} · {source.date}
      </Text>
      <Text style={[ui.hint, ui.smallGap]}>
        {source.walletName} · {source.mode === 'sample' ? 'Sample data' : 'Saved transaction'}
      </Text>
      <Text style={[ui.hint, ui.smallGap]}>
        Captured when this panel opened. Later record edits do not change this output.
      </Text>
      <View style={ui.divider}>
        <Text style={ui.heading} accessibilityRole="header">
          Include in PDF
        </Text>
        <Text style={[ui.hint, ui.smallGap]}>
          Optional personal details start off for every export. QR choices below are separate.
        </Text>
        <ExportContextOptions
          source={source}
          selection={selection}
          onChange={setSelection}
          disabled={pdf.busy}
        />
        <SelectedExportDetails snapshot={snapshot} />
      </View>
      <PdfExportActions state={pdf} />
      <TransactionQrPanel source={source} renderQr={renderQr} />
    </Sheet>
  );
}

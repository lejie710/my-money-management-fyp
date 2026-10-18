import React from 'react';
import { Text, View } from 'react-native';
import { formatMoney } from '../core/model';
import type { ReportExportSnapshot } from '../core/exports';
import type { PdfUiServices } from './exportTypes';
import { Sheet } from './components';
import { PdfExportActions } from './PdfExportActions';
import { usePdfExport } from './usePdfExport';
import { ui } from './theme';

export function ReportExportSheet({
  snapshot,
  sessionKey,
  services,
  onClose,
}: {
  snapshot: ReportExportSnapshot;
  sessionKey: string;
  services: PdfUiServices;
  onClose: () => void;
}) {
  const pdf = usePdfExport(snapshot, sessionKey, services);
  const money = (amount: number) => formatMoney(amount, snapshot.currency);
  return (
    <Sheet title="Export report" onClose={onClose}>
      <Text style={ui.heading}>{snapshot.walletName}</Text>
      {snapshot.mode === 'sample' ? (
        <Text style={[ui.body, ui.smallGap]} testID="export-sample-label">
          Sample data
        </Text>
      ) : null}
      <Text selectable style={[ui.body, ui.smallGap]} testID="export-report-period">
        {snapshot.startDate} to {snapshot.endDate} · both dates included
      </Text>
      <Text style={[ui.hint, ui.smallGap]}>
        This captures the applied report when you opened export. Later edits do not change this
        output.
      </Text>
      {[
        ['Opening balance', snapshot.openingMinor],
        ['Income', snapshot.incomeMinor],
        ['Expenses', snapshot.expenseMinor],
        ['Debt payments', snapshot.debtMinor],
        ['Total outflow', snapshot.outflowMinor],
        ['Net change', snapshot.netMinor],
        ['Period closing balance', snapshot.closingMinor],
        ['All-record wallet balance', snapshot.currentBalanceMinor],
      ].map(([label, amount]) => (
        <View key={String(label)} style={[ui.between, ui.smallGap]}>
          <Text style={[ui.body, ui.flex]}>{label}</Text>
          <Text selectable style={[ui.body, ui.number, { maxWidth: '48%', textAlign: 'right' }]}>
            {money(Number(amount))}
          </Text>
        </View>
      ))}
      <Text style={[ui.hint, ui.gap]}>
        {snapshot.categoryBreakdown.length} category rows and {snapshot.monthly.length} monthly
        rows. The PDF includes their exact amounts; its chart shows up to the latest 12 selected
        months.
      </Text>
      <Text style={[ui.hint, ui.smallGap]}>
        All-record balance includes dates outside this period. This is a report summary, not a full
        transaction statement or backup.
      </Text>
      <PdfExportActions state={pdf} />
    </Sheet>
  );
}

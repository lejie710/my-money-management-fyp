import React from 'react';
import { Pressable, Text, View } from 'react-native';
import type {
  ContextSelection,
  TransactionExportSource,
  TransactionExportSnapshot,
} from '../core/exports';
import { colors, ui } from './theme';

export function ExportContextOptions({
  source,
  selection,
  onChange,
  disabled = false,
  qr = false,
}: {
  source: TransactionExportSource;
  selection: ContextSelection;
  onChange: (next: ContextSelection) => void;
  disabled?: boolean;
  qr?: boolean;
}) {
  const options: { key: keyof ContextSelection; label: string; available: boolean }[] = [
    { key: 'notes', label: 'Notes', available: !!source.context.notes },
    { key: 'withPerson', label: 'Person name', available: !!source.context.withPerson },
    { key: 'location', label: 'Place label', available: !!source.context.location },
    ...(!qr ? [{ key: 'photo' as const, label: 'Photo', available: !!source.context.photo }] : []),
  ];
  return (
    <View style={ui.smallGap}>
      {options.map((option) => (
        <Pressable
          key={option.key}
          accessibilityRole="checkbox"
          accessibilityLabel={`Include ${option.label.toLowerCase()} in ${qr ? 'QR' : 'PDF'}`}
          accessibilityState={{
            checked: selection[option.key],
            disabled: disabled || !option.available,
          }}
          disabled={disabled || !option.available}
          onPress={() => onChange({ ...selection, [option.key]: !selection[option.key] })}
          testID={`${qr ? 'qr' : 'pdf'}-include-${option.key}`}
          style={({ pressed }) => [
            {
              minHeight: 50,
              paddingVertical: 10,
              borderBottomWidth: 1,
              borderBottomColor: colors.border,
            },
            pressed && ui.pressed,
            (disabled || !option.available) && ui.disabled,
          ]}
        >
          <View style={ui.between}>
            <Text style={[ui.body, ui.flex]}>{option.label}</Text>
            <Text style={[ui.hint, { color: selection[option.key] ? colors.green : colors.muted }]}>
              {!option.available
                ? 'Not recorded'
                : selection[option.key]
                  ? 'Included'
                  : 'Not included'}
            </Text>
          </View>
        </Pressable>
      ))}
    </View>
  );
}

export function SelectedExportDetails({
  snapshot,
  qr = false,
}: {
  snapshot: TransactionExportSnapshot;
  qr?: boolean;
}) {
  const { details, selection } = snapshot;
  const anyText = selection.notes || selection.withPerson || selection.location;
  return (
    <View style={ui.smallGap} testID={qr ? 'qr-selected-details' : 'pdf-selected-details'}>
      {selection.notes ? (
        <>
          <Text style={ui.fieldLabel}>Included notes</Text>
          <Text selectable style={ui.body}>
            {details.notes || 'No notes recorded.'}
          </Text>
        </>
      ) : null}
      {selection.withPerson ? (
        <>
          <Text style={ui.fieldLabel}>Included person</Text>
          <Text selectable style={ui.body}>
            {details.withPerson || 'No person recorded.'}
          </Text>
        </>
      ) : null}
      {selection.location ? (
        <>
          <Text style={ui.fieldLabel}>Included place</Text>
          <Text selectable style={ui.body}>
            {details.location || 'No place recorded.'}
          </Text>
        </>
      ) : null}
      {!qr && selection.photo ? (
        <Text style={[ui.body, ui.smallGap]}>
          {snapshot.attachment
            ? 'Photo selected. Its owned file will be checked when the PDF is created; any unavailable photo is labelled in the PDF.'
            : 'No photo recorded.'}
        </Text>
      ) : null}
      {!anyText && (qr || !selection.photo) ? (
        <Text style={ui.hint}>Summary only. Optional personal details are not included.</Text>
      ) : null}
    </View>
  );
}

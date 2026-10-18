import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { AppIcon } from './AppIcon';
import { colors, ui } from './theme';
import type { useCompanionConnection } from './useCompanionConnection';

export function ReceiptEntry({
  connection,
  busy,
  onOpen,
  compact = false,
}: {
  connection: ReturnType<typeof useCompanionConnection>;
  busy: boolean;
  onOpen(): void;
  compact?: boolean;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const checking = connection.phase === 'checking';
  const recheckDisabled = busy || !connection.enabled || checking;
  const status = {
    disabled: 'Recognition not enabled',
    'not-configured': 'Connection not set up',
    checking: 'Checking connection…',
    configured: 'Connection configured',
    unavailable: 'Connection needs attention',
  }[connection.phase];
  return (
    <View style={styles.group}>
      <View style={styles.receiptRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Review a receipt. ${status}`}
          accessibilityState={{ disabled: busy || checking }}
          disabled={busy || checking}
          onPress={onOpen}
          testID="open-receipt-capture"
          style={({ pressed }) => [
            styles.openAction,
            pressed && ui.pressed,
            (busy || checking) && ui.disabled,
          ]}
        >
          <AppIcon name="receipt" size={22} color={colors.accent} />
          <View style={styles.receiptText}>
            <Text style={styles.receiptTitle}>Review receipt</Text>
            <Text
              style={styles.status}
              testID={compact ? 'receipt-shortcut-detail' : 'companion-connection-status'}
            >
              {compact ? 'Check a photo before saving an expense' : status}
            </Text>
          </View>
        </Pressable>
        {!compact ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${status}. ${showDetails ? 'Hide' : 'Show'} connection details`}
            accessibilityState={{ expanded: showDetails }}
            onPress={() => setShowDetails((value) => !value)}
            testID="receipt-connection-details"
            style={({ pressed }) => [styles.setupAction, pressed && ui.pressed]}
          >
            <Text style={styles.setupLabel}>{showDetails ? 'Hide' : 'Setup'}</Text>
            <View style={{ transform: [{ rotate: showDetails ? '270deg' : '90deg' }] }}>
              <AppIcon name="chevron" size={14} color={colors.accent} />
            </View>
          </Pressable>
        ) : null}
      </View>
      {!compact && showDetails ? (
        <View style={styles.details}>
          <Text style={styles.connectionDetail}>{connection.message}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={checking ? 'Checking connection…' : 'Recheck connection'}
            accessibilityState={{ disabled: recheckDisabled }}
            disabled={recheckDisabled}
            onPress={() => {
              void connection.recheck();
            }}
            testID="recheck-companion-connection"
            style={({ pressed }) => [
              styles.recheck,
              pressed && ui.pressed,
              recheckDisabled && ui.disabled,
            ]}
          >
            <Text style={styles.recheckLabel}>{checking ? 'Checking…' : 'Recheck'}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    marginTop: 10,
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  receiptRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 8 },
  openAction: {
    flex: 1,
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 13,
  },
  receiptText: { flex: 1, gap: 3 },
  receiptTitle: { color: colors.text, fontSize: 16, lineHeight: 22, fontWeight: '600' },
  setupAction: {
    minWidth: 64,
    minHeight: 48,
    paddingVertical: 10,
    paddingLeft: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
    maxWidth: '35%',
  },
  status: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  setupLabel: {
    color: colors.accent,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '500',
    flexShrink: 1,
  },
  details: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 2,
  },
  recheck: {
    minHeight: 48,
    minWidth: 64,
    paddingVertical: 10,
    paddingLeft: 4,
    justifyContent: 'center',
    alignItems: 'flex-end',
    alignSelf: 'flex-end',
  },
  recheckLabel: {
    color: colors.accent,
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '600',
    textAlign: 'right',
  },
  connectionDetail: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19,
  },
});

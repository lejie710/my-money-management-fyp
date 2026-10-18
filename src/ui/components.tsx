import React, { ReactNode, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  useWindowDimensions,
  View,
} from 'react-native';
import { AppIcon, type IconName } from './AppIcon';
import { colors, ui } from './theme';

export type ActionProps = {
  label: string;
  onPress: () => void;
  secondary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  testID?: string;
};
export function Action({ label, onPress, secondary, danger, disabled, testID }: ActionProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        secondary && styles.secondary,
        danger && styles.danger,
        pressed && ui.pressed,
        disabled && ui.disabled,
      ]}
    >
      <Text
        style={[styles.actionText, secondary && styles.secondaryText, danger && styles.dangerText]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function Choice({
  label,
  selected,
  onPress,
  disabled,
  testID,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled: !!disabled }}
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      style={({ pressed }) => [
        styles.choice,
        selected && styles.selected,
        pressed && ui.pressed,
        disabled && ui.disabled,
      ]}
    >
      <Text style={[styles.choiceText, selected && ui.selectedText]}>{label}</Text>
    </Pressable>
  );
}

export function Field({
  label,
  hint,
  ...props
}: TextInputProps & { label: string; hint?: string }) {
  const [focused, setFocused] = useState(false);
  return (
    <View>
      <Text style={ui.fieldLabel}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.muted}
        selectionColor={colors.accent}
        accessibilityLabel={label}
        {...props}
        onFocus={(event) => {
          setFocused(true);
          props.onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          props.onBlur?.(event);
        }}
        style={[ui.input, focused && styles.focusedInput, props.style]}
      />
      {hint ? <Text style={[ui.hint, { marginTop: 6 }]}>{hint}</Text> : null}
    </View>
  );
}

export type RowActionProps = {
  label: string;
  detail?: string;
  icon?: IconName;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
  danger?: boolean;
  last?: boolean;
};

export function RowAction({
  label,
  detail,
  icon,
  onPress,
  disabled,
  testID,
  danger,
  last,
}: RowActionProps) {
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={detail ? `${label}. ${detail}` : label}
        accessibilityState={{ disabled: !!disabled }}
        disabled={disabled}
        testID={testID}
        onPress={onPress}
        style={({ pressed }) => [
          styles.rowAction,
          pressed && styles.rowPressed,
          disabled && ui.disabled,
        ]}
      >
        {icon ? (
          <View style={[styles.rowIcon, danger && styles.danger]}>
            <AppIcon name={icon} size={21} color={danger ? colors.red : colors.accent} />
          </View>
        ) : null}
        <View style={ui.flex}>
          <Text style={[styles.rowLabel, danger && styles.dangerText]}>{label}</Text>
          {detail ? <Text style={[ui.hint, styles.rowDetail]}>{detail}</Text> : null}
        </View>
        <AppIcon name="chevron" size={17} color={colors.muted} />
      </Pressable>
      {!last ? <View style={[styles.rowSeparator, { marginLeft: icon ? 64 : 16 }]} /> : null}
    </View>
  );
}

export function SectionHeading({
  title,
  detail,
  actionLabel,
  onAction,
  testID,
}: {
  title: string;
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
  testID?: string;
}) {
  return (
    <View testID={testID}>
      <View style={styles.sectionHeading}>
        <Text style={[ui.heading, ui.flex]} accessibilityRole="header">
          {title}
        </Text>
        {actionLabel && onAction ? (
          <Pressable
            accessibilityRole="button"
            onPress={onAction}
            testID={testID ? `${testID}-action` : undefined}
            style={({ pressed }) => [styles.sectionAction, pressed && ui.pressed]}
          >
            <Text style={styles.sectionActionText}>{actionLabel}</Text>
          </Pressable>
        ) : null}
      </View>
      {detail ? <Text style={ui.body}>{detail}</Text> : null}
    </View>
  );
}

export function FormError({ message, testID }: { message: string; testID?: string }) {
  return message ? (
    <Text
      selectable
      style={ui.error}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      testID={testID}
    >
      {message}
    </Text>
  ) : null;
}

export function Sheet({
  title,
  onClose,
  children,
  busy = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  busy?: boolean;
}) {
  const { width, height } = useWindowDimensions();
  const spacious = width >= 700 && height >= 600;
  const requestClose = () => {
    if (!busy) onClose();
  };
  return (
    <Modal visible transparent animationType="none" onRequestClose={requestClose}>
      <KeyboardAvoidingView
        style={[styles.backdrop, spacious && styles.spaciousBackdrop]}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={[styles.sheet, spacious && styles.spaciousSheet]} accessibilityViewIsModal>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle} accessibilityRole="header">
              {title}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Close ${title.toLowerCase()}`}
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              onPress={requestClose}
              style={({ pressed }) => [styles.close, pressed && ui.pressed, busy && ui.disabled]}
              testID="close-editor"
            >
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={styles.sheetContent}
          >
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function Screen({ children }: { children: ReactNode }) {
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={ui.screen}
    >
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  action: {
    minHeight: 50,
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: colors.accent,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionText: {
    color: colors.onAccent,
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '600',
    textAlign: 'center',
  },
  secondary: { backgroundColor: colors.accentSoft },
  secondaryText: { color: colors.accent },
  danger: { backgroundColor: colors.redSoft },
  dangerText: { color: colors.red },
  focusedInput: { borderColor: colors.accent },
  choice: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    backgroundColor: colors.surface,
    paddingHorizontal: 14,
    paddingVertical: 11,
    justifyContent: 'center',
    alignItems: 'center',
  },
  selected: { backgroundColor: colors.accentSoft, borderColor: colors.accentSoft },
  choiceText: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '500',
    textAlign: 'center',
  },
  rowAction: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  rowPressed: { backgroundColor: colors.raised },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentSoft,
  },
  rowLabel: { color: colors.text, fontSize: 16, lineHeight: 23, fontWeight: '500' },
  rowDetail: { marginTop: 3 },
  rowSeparator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.separator },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 40 },
  sectionAction: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 4 },
  sectionActionText: { color: colors.accent, fontSize: 15, lineHeight: 21, fontWeight: '600' },
  backdrop: {
    flex: 1,
    backgroundColor: colors.scrim,
    justifyContent: 'flex-end',
    paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) + 12 : 48,
  },
  spaciousBackdrop: { justifyContent: 'center', paddingHorizontal: 24, paddingBottom: 24 },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    maxHeight: '100%',
    width: '100%',
    maxWidth: 680,
    alignSelf: 'center',
    overflow: 'hidden',
    flexShrink: 1,
  },
  spaciousSheet: { borderRadius: 24 },
  sheetHeader: {
    paddingLeft: 20,
    paddingRight: 8,
    paddingTop: 6,
    paddingBottom: 6,
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
    gap: 6,
  },
  sheetTitle: {
    color: colors.text,
    fontSize: 20,
    lineHeight: 27,
    fontWeight: '600',
    flex: 1,
    letterSpacing: -0.3,
  },
  close: { paddingHorizontal: 12, minHeight: 48, justifyContent: 'center' },
  closeText: { color: colors.accent, fontSize: 15, lineHeight: 21, fontWeight: '600' },
  sheetContent: { padding: 20, paddingTop: 8, paddingBottom: 40 },
});

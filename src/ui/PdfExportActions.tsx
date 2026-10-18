import React from 'react';
import { Text, View } from 'react-native';
import { Action, FormError } from './components';
import type { usePdfExport } from './usePdfExport';
import { ui } from './theme';

export function PdfExportActions({ state }: { state: ReturnType<typeof usePdfExport> }) {
  return (
    <View style={ui.divider}>
      <Text style={ui.heading} accessibilityRole="header">
        PDF
      </Text>
      <Text style={[ui.hint, ui.smallGap]}>
        Create a local PDF first. Sharing and system preview / printing are separate actions.
      </Text>
      <View style={ui.smallGap}>
        <Action
          label={
            state.stage === 'preparing'
              ? 'Creating PDF…'
              : state.artifact
                ? 'Create PDF again'
                : 'Create PDF'
          }
          disabled={state.busy}
          onPress={() => {
            void state.prepare();
          }}
          testID="export-create-pdf"
        />
      </View>
      {state.artifact ? (
        <>
          <Text selectable style={[ui.body, ui.smallGap]} testID="export-pdf-ready">
            PDF ready · {state.artifact.pageCount}{' '}
            {state.artifact.pageCount === 1 ? 'page' : 'pages'} ·{' '}
            {Math.max(1, Math.ceil(state.artifact.byteSize / 1024))} KB
          </Text>
          <Text selectable style={ui.hint} testID="export-file-name">
            {state.artifact.fileName}
          </Text>
          {state.preview ? (
            <View style={ui.smallGap}>
              <Action
                secondary
                label={
                  state.stage === 'previewing' ? 'Opening preview / print…' : 'Preview / print PDF'
                }
                disabled={state.busy}
                onPress={() => {
                  void state.preview?.();
                }}
                testID="export-preview-pdf"
              />
            </View>
          ) : null}
          <View style={ui.smallGap}>
            <Action
              secondary
              label={state.stage === 'sharing' ? 'Opening sharing…' : 'Share PDF'}
              disabled={state.busy}
              onPress={() => {
                void state.share();
              }}
              testID="export-share-pdf"
            />
          </View>
        </>
      ) : null}
      {state.warning ? (
        <Text selectable style={[ui.body, ui.smallGap]} testID="export-warning">
          {state.warning}
        </Text>
      ) : null}
      {state.message ? (
        <Text
          selectable
          style={[ui.body, ui.smallGap]}
          accessibilityLiveRegion="polite"
          testID="export-status"
        >
          {state.message}
        </Text>
      ) : null}
      <FormError message={state.error} testID="export-error" />
      <Text style={[ui.hint, ui.smallGap]}>
        The PDF stays in temporary app storage and may be removed by the device. Opening sharing
        does not confirm delivery.
      </Text>
    </View>
  );
}

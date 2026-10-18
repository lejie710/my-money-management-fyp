import React, { useState } from 'react';
import { ActivityIndicator, Image, Text, View } from 'react-native';
import type { Ledger, Transaction } from '../core/model';
import { Action, FormError, Sheet } from './components';
import { ReceiptReviewFields } from './ReceiptReviewFields';
import { useReceiptCapture } from './useReceiptCapture';
import type { ReceiptUiBinding } from './receiptUiTypes';
import type { SaveLedger } from './useLedger';
import { colors, ui } from './theme';

type Props = {
  ledger: Ledger;
  binding: ReceiptUiBinding;
  onSave: SaveLedger;
  saveError: string;
  onClose: () => void;
  onManualEntry: () => void;
  prepareReceiptOrigin?: (transaction: Transaction, captureId: string) => Transaction;
};
export function ReceiptCaptureSheet(props: Props) {
  return <ReceiptCaptureContent key={props.binding.sessionKey} {...props} />;
}
function ReceiptCaptureContent({
  ledger,
  binding,
  onSave,
  saveError,
  onClose,
  onManualEntry,
  prepareReceiptOrigin,
}: Props) {
  const draft = useReceiptCapture({ ledger, binding, onSave, onClose, prepareReceiptOrigin });
  const [expandedImage, setExpandedImage] = useState(false);
  const [failedPreview, setFailedPreview] = useState<string | null>(null);
  const saving = draft.phase === 'saving';
  const selecting = draft.phase === 'selecting';
  const close = () => {
    if (draft.close()) onClose();
  };
  const manual = () => {
    if (draft.close()) {
      onClose();
      onManualEntry();
    }
  };
  return (
    <Sheet title="Review a receipt" onClose={close} busy={saving}>
      <Text style={ui.heading}>Windows-assisted receipt recognition</Text>
      <Text style={[ui.body, ui.smallGap]}>
        Choose a receipt image, then explicitly request recognition. Its image bytes go to the local
        Windows companion on your computer for OCR. No cloud OCR or automatic transaction is used.
      </Text>
      {!binding.client ? (
        <Text style={[ui.body, ui.smallGap]} testID="receipt-connection-status">
          No local companion configuration is available. Close this panel and choose Recheck
          connection after pairing. Manual transaction entry remains available.
        </Text>
      ) : (
        <Text style={[ui.hint, ui.smallGap]} testID="receipt-connection-status">
          Local connection configured. Availability is checked when you choose Recognize receipt.
        </Text>
      )}
      <View style={ui.gap}>
        <Action
          label={selecting ? 'Opening image selection…' : 'Choose receipt image'}
          disabled={saving || selecting}
          onPress={() => {
            void draft.select('library');
          }}
          testID="receipt-pick-image"
        />
      </View>
      <View style={ui.smallGap}>
        <Action
          secondary
          label="Take receipt photo"
          disabled={saving || selecting || !binding.capture.cameraAvailable}
          onPress={() => {
            void draft.select('camera');
          }}
          testID="receipt-take-photo"
        />
      </View>
      {!binding.capture.cameraAvailable ? (
        <Text style={[ui.hint, ui.smallGap]}>
          Camera capture is unavailable in this build. Choose an existing image instead.
        </Text>
      ) : null}
      {draft.image ? (
        <View style={ui.gap}>
          {failedPreview === draft.image.id ? (
            <Text style={ui.body} testID="receipt-preview-error">
              The selected preview is unavailable. Choose the image again before reviewing its
              fields.
            </Text>
          ) : (
            <Image
              key={draft.image.id}
              source={{ uri: draft.image.uri }}
              resizeMode="contain"
              style={{
                width: '100%',
                height: expandedImage ? 520 : 240,
                backgroundColor: colors.background,
                borderRadius: 12,
              }}
              accessibilityLabel="Selected receipt image for reviewing suggested fields"
              testID="receipt-image-preview"
              onError={() => setFailedPreview(draft.image!.id)}
            />
          )}
          <View style={ui.smallGap}>
            <Action
              secondary
              label={expandedImage ? 'Use compact image preview' : 'Expand image preview'}
              disabled={saving || selecting}
              onPress={() => setExpandedImage((value) => !value)}
              testID="receipt-expand-image"
            />
          </View>
          {draft.phase === 'recognizing' ? (
            <View style={ui.smallGap}>
              <ActivityIndicator color={colors.purple} />
              <Text
                style={[ui.body, ui.smallGap]}
                accessibilityLiveRegion="polite"
                testID="receipt-recognizing"
              >
                Reading this image with the Windows companion…
              </Text>
              <View style={ui.smallGap}>
                <Action
                  secondary
                  label="Cancel recognition"
                  onPress={draft.cancelRecognition}
                  testID="receipt-cancel-recognition"
                />
              </View>
            </View>
          ) : (
            <View style={ui.smallGap}>
              <Action
                secondary
                label={draft.candidate ? 'Recognize again and replace review' : 'Recognize receipt'}
                disabled={
                  saving || selecting || !binding.client || failedPreview === draft.image.id
                }
                onPress={() => {
                  void draft.recognize();
                }}
                testID="receipt-recognize"
              />
            </View>
          )}
        </View>
      ) : null}
      {draft.message ? (
        <Text style={[ui.body, ui.gap]} accessibilityLiveRegion="polite" testID="receipt-status">
          {draft.message}
        </Text>
      ) : null}
      {draft.phase === 'blank' ? (
        <View style={ui.gap} testID="receipt-empty-result">
          <Text style={ui.heading}>No readable receipt text</Text>
          <Text style={[ui.body, ui.smallGap]}>
            No title, date or total has been filled in. Retake a clearer image, select another, or
            enter an expense manually.
          </Text>
        </View>
      ) : null}
      {draft.phase === 'review' || saving ? (
        <ReceiptReviewFields
          draft={draft}
          ledger={ledger}
          previewAvailable={!!draft.image && failedPreview !== draft.image.id}
        />
      ) : null}
      <FormError message={draft.error || saveError} testID="receipt-error" />
      <View style={ui.gap}>
        <Action
          secondary
          label="Enter transaction manually"
          disabled={saving || selecting}
          onPress={manual}
          testID="receipt-manual-entry"
        />
      </View>
      <Text style={[ui.hint, ui.smallGap]}>
        Manual entry opens an empty ordinary transaction form without copying OCR guesses.
      </Text>
    </Sheet>
  );
}

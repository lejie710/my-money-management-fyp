import React from 'react';
import { Pressable, Text, View } from 'react-native';
import type { PhotoManager } from '../attachments/photoManager';
import {
  MAX_NOTES_LENGTH,
  MAX_PERSON_NAME_LENGTH,
  MAX_PLACE_LABEL_LENGTH,
} from '../core/transactionContext';
import { Action, Field, FormError } from './components';
import { TransactionPhotoPreview } from './TransactionPhotoPreview';
import type { TransactionContextDraft } from './useTransactionContext';
import { colors, ui } from './theme';

const sourceLabel = (source?: string) =>
  source === 'contacts'
    ? 'Selected from contacts'
    : source === 'device'
      ? 'Confirmed from current location'
      : source === 'map'
        ? 'Confirmed from map selection'
        : source === 'recorded'
          ? 'Recorded with this transaction'
          : 'Entered manually';

export function TransactionContextFields({
  draft,
  expanded,
  onExpandedChange,
  photos,
  disabled,
  onOpenMap,
}: {
  draft: TransactionContextDraft;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  photos: PhotoManager | null;
  disabled: boolean;
  onOpenMap?: () => void;
}) {
  const photo = draft.photoEdit.kind === 'remove' ? null : draft.originalPhoto;
  const selectedUri = draft.photoEdit.kind === 'selected' ? draft.photoEdit.picked.uri : undefined;
  const summary = [
    draft.notes.trim() ? 'Notes' : '',
    photo || selectedUri ? 'Photo' : '',
    draft.person?.name ? 'Person' : '',
    draft.place?.label ? 'Place' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const nativeBusy = disabled || draft.pending !== null;
  return (
    <View style={ui.divider}>
      <Pressable
        testID="transaction-optional-details"
        accessibilityRole="button"
        accessibilityState={{ expanded, disabled }}
        disabled={disabled}
        onPress={() => onExpandedChange(!expanded)}
        style={({ pressed }) => [{ minHeight: 52, paddingVertical: 8 }, pressed && ui.pressed]}
      >
        <View style={ui.between}>
          <Text style={ui.heading}>Optional details</Text>
          <Text style={{ color: colors.purple, fontSize: 14 }}>{expanded ? 'Hide' : 'Show'}</Text>
        </View>
        <Text style={[ui.hint, { marginTop: 4 }]} testID="transaction-context-summary">
          {summary || 'Notes, a photo, person or place'}
        </Text>
      </Pressable>
      {expanded ? (
        <>
          <Field
            label="Notes"
            value={draft.notes}
            onChangeText={draft.setNotes}
            editable={!disabled}
            multiline
            maxLength={MAX_NOTES_LENGTH}
            testID="transaction-notes-input"
            style={{ minHeight: 110, textAlignVertical: 'top' }}
            hint="Optional. Saved with this transaction on this device."
          />
          <Text style={ui.fieldLabel}>Photo</Text>
          <TransactionPhotoPreview photos={photos} photo={photo} draftUri={selectedUri} />
          <View style={ui.smallGap}>
            <Action
              secondary
              label={
                draft.pending === 'photo'
                  ? 'Opening photo library…'
                  : photo || selectedUri
                    ? 'Change photo'
                    : 'Add photo from library'
              }
              disabled={nativeBusy}
              onPress={() => {
                void draft.pickPhoto();
              }}
              testID="pick-transaction-photo"
            />
          </View>
          {photo || selectedUri ? (
            <View style={ui.smallGap}>
              <Action
                secondary
                label="Remove photo"
                disabled={disabled}
                onPress={draft.removePhoto}
                testID="remove-transaction-photo"
              />
            </View>
          ) : null}
          <Field
            label="Person name"
            value={draft.person?.name ?? ''}
            onChangeText={draft.setPersonName}
            editable={!disabled}
            maxLength={MAX_PERSON_NAME_LENGTH}
            testID="transaction-person-input"
            placeholder="Optional name"
          />
          {draft.person ? (
            <Text style={ui.hint} testID="transaction-person-source">
              {sourceLabel(draft.person.source)}
            </Text>
          ) : null}
          <View style={ui.smallGap}>
            <Action
              secondary
              label={draft.pending === 'person' ? 'Opening contacts…' : 'Choose from contacts'}
              disabled={nativeBusy}
              onPress={() => {
                void draft.pickPerson();
              }}
              testID="pick-transaction-contact"
            />
          </View>
          {draft.person ? (
            <View style={ui.smallGap}>
              <Action
                secondary
                label="Remove person"
                disabled={disabled}
                onPress={() => draft.setPersonName('')}
                testID="remove-transaction-person"
              />
            </View>
          ) : null}
          {draft.personCandidate ? (
            <View style={[ui.card, ui.smallGap]}>
              <Text selectable style={ui.body}>
                Selected name: {draft.personCandidate.name}
              </Text>
              <Text style={ui.hint}>Only this name is saved. Contact details are not linked.</Text>
              <View style={ui.smallGap}>
                <Action
                  label="Use this name"
                  disabled={disabled}
                  onPress={draft.confirmPerson}
                  testID="confirm-transaction-person"
                />
              </View>
              <View style={ui.smallGap}>
                <Action
                  secondary
                  label="Keep previous name"
                  disabled={disabled}
                  onPress={draft.cancelPerson}
                  testID="cancel-transaction-person"
                />
              </View>
            </View>
          ) : null}
          <Field
            label="Place label"
            multiline
            style={{ minHeight: 112, textAlignVertical: 'top' }}
            value={draft.place?.label ?? ''}
            onChangeText={draft.setPlaceLabel}
            editable={!disabled}
            maxLength={MAX_PLACE_LABEL_LENGTH}
            testID="transaction-place-input"
            placeholder="Optional place"
          />
          {draft.place ? (
            <Text style={ui.hint} testID="transaction-place-source">
              {sourceLabel(draft.place.source)}
            </Text>
          ) : null}
          <View style={ui.smallGap}>
            <Action
              secondary
              label={draft.pending === 'place' ? 'Finding current place…' : 'Use current location'}
              disabled={nativeBusy}
              onPress={() => {
                void draft.locatePlace();
              }}
              testID="use-current-location"
            />
          </View>
          {onOpenMap ? (
            <View style={ui.smallGap}>
              <Action
                secondary
                label="Choose on map"
                disabled={nativeBusy}
                onPress={onOpenMap}
                testID="choose-map-location"
              />
            </View>
          ) : null}
          <Text style={[ui.hint, { marginTop: 6 }]}>
            Location is requested only when you choose it. Address lookup may use an online platform
            service; only your confirmed label is saved.
          </Text>
          {draft.place ? (
            <View style={ui.smallGap}>
              <Action
                secondary
                label="Remove place"
                disabled={disabled}
                onPress={() => draft.setPlaceLabel('')}
                testID="remove-transaction-place"
              />
            </View>
          ) : null}
          {draft.placeCandidate ? (
            <View style={[ui.card, ui.smallGap]}>
              <Text selectable style={ui.body}>
                {draft.placeCandidate.label}
              </Text>
              <Text style={ui.hint}>
                Check this label before adding it. Coordinates are not saved.
              </Text>
              <View style={ui.smallGap}>
                <Action
                  label="Use this place"
                  disabled={disabled}
                  onPress={draft.confirmPlace}
                  testID="confirm-transaction-place"
                />
              </View>
              <View style={ui.smallGap}>
                <Action
                  secondary
                  label="Keep previous place"
                  disabled={disabled}
                  onPress={draft.cancelPlace}
                  testID="cancel-transaction-place"
                />
              </View>
            </View>
          ) : null}
        </>
      ) : null}
      <FormError message={draft.error} testID="transaction-context-error" />
    </View>
  );
}

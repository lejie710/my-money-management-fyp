import React, { useEffect, useState } from 'react';
import { Image, Text, View } from 'react-native';
import type { PhotoRef } from '../core/transactionContext';
import type { PhotoManager } from '../attachments/photoManager';
import { useTheme } from './theme';

export function TransactionPhotoPreview({
  photo,
  draftUri,
  photos,
}: {
  photo?: PhotoRef | null;
  draftUri?: string;
  photos: PhotoManager | null;
}) {
  const { colors, ui } = useTheme();
  const key =
    draftUri ?? (photo ? `${photo.ownerIncarnationId}/${photo.id}/${photo.fileName}` : 'none');
  const [display, setDisplay] = useState<{
    key: string;
    uri: string | null;
    loading: boolean;
    manager: PhotoManager | null;
  }>({ key, uri: null, loading: true, manager: photos });
  useEffect(() => {
    let active = true;
    setDisplay({ key, uri: null, loading: true, manager: photos });
    void (async () => {
      try {
        const uri =
          draftUri ??
          (photo && photos && (await photos.inspect(photo)) ? photos.uriFor(photo) : null);
        if (active) setDisplay({ key, uri, loading: false, manager: photos });
      } catch {
        if (active) setDisplay({ key, uri: null, loading: false, manager: photos });
      }
    })();
    return () => {
      active = false;
    };
  }, [key, photos, photo, draftUri]);
  if (!photo && !draftUri) return null;
  const ready = display.key === key && display.manager === photos && !display.loading;
  return (
    <View style={ui.smallGap}>
      <Text style={ui.hint}>
        {draftUri ? 'Draft photo · save the transaction to keep it' : 'Saved photo'}
      </Text>
      {ready && display.uri ? (
        <Image
          key={key}
          source={{ uri: display.uri }}
          resizeMode="contain"
          style={{
            width: '100%',
            height: 210,
            borderRadius: 12,
            backgroundColor: colors.background,
            marginTop: 8,
          }}
          accessibilityLabel={
            draftUri ? 'Selected transaction photo preview' : 'Saved transaction photo'
          }
          testID="transaction-photo-preview"
          onError={() =>
            setDisplay((value) =>
              value.key === key && value.manager === photos
                ? { key, uri: null, loading: false, manager: photos }
                : value,
            )
          }
        />
      ) : (
        <Text selectable style={[ui.body, ui.smallGap]} testID="transaction-photo-error">
          {ready
            ? 'Photo unavailable. You can replace or remove it without losing this transaction.'
            : 'Checking photo…'}
        </Text>
      )}
    </View>
  );
}

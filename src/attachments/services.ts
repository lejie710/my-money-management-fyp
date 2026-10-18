import * as ImagePicker from 'expo-image-picker';
import {
  Contact,
  getPermissionsAsync as getContactsPermissions,
  requestPermissionsAsync as requestContactsPermissions,
} from 'expo-contacts';
import * as Location from 'expo-location';
import { Platform } from 'react-native';
import type { PhotoFileAdapter } from './photoManager';
import type { TransactionContextServices } from '../ui/transactionContextTypes';
type Coordinate = { latitude: number; longitude: number };

function bounded<T>(work: Promise<T>, message: string, milliseconds = 20000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function coordinate(value: Coordinate): Coordinate {
  if (
    !value ||
    !Number.isFinite(value.latitude) ||
    Math.abs(value.latitude) > 90 ||
    !Number.isFinite(value.longitude) ||
    Math.abs(value.longitude) > 180
  ) {
    throw new Error(
      'The selected location is invalid. Choose another point or enter a place label.',
    );
  }
  return { latitude: value.latitude, longitude: value.longitude };
}

async function foregroundPermission() {
  let permission = await Location.getForegroundPermissionsAsync();
  if (!permission.granted && permission.canAskAgain)
    permission = await Location.requestForegroundPermissionsAsync();
  if (!permission.granted)
    throw new Error('Location permission is unavailable. You can enter a place label manually.');
}

async function labelAt(point: Coordinate): Promise<string | null> {
  try {
    const results = await bounded(
      Location.reverseGeocodeAsync(point),
      'Address lookup took too long. Enter a place label or retry.',
    );
    const first = results[0];
    if (!first) return null;
    const parts = [
      first.name,
      first.street,
      first.district,
      first.city,
      first.region,
      first.country,
    ]
      .filter((part): part is string => typeof part === 'string' && !!part.trim())
      .map((part) => part.trim());
    const label = first.formattedAddress?.trim() || [...new Set(parts)].join(', ');
    return label && label.length <= 240 ? label : null;
  } catch {
    // A valid point remains available for explicit review/manual naming. A lookup error is never a place label.
    return null;
  }
}

export function createContextServices(files: PhotoFileAdapter): TransactionContextServices {
  return {
    async pickPhoto() {
      if (Platform.OS === 'android') {
        const interrupted = await ImagePicker.getPendingResultAsync();
        if (interrupted && !('canceled' in interrupted && interrupted.canceled)) {
          throw new Error(
            'An earlier photo selection was interrupted. Choose the photo again for this transaction.',
          );
        }
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: false,
        exif: false,
        base64: false,
      });
      if (result.canceled) return null;
      const asset = result.assets?.[0];
      if (!asset || result.assets.length !== 1) throw new Error('Choose one supported photo.');
      await files.inspectSource(asset.uri);
      return { uri: asset.uri };
    },
    async pickContactName() {
      // The SDK picker returns an ID-backed Contact. getFullName subsequently
      // queries the contact store, so selection alone is not its read permission.
      let permission = await getContactsPermissions();
      if (!permission.granted && permission.canAskAgain)
        permission = await requestContactsPermissions();
      if (!permission.granted)
        throw new Error('Contacts permission is unavailable. Enter the person name manually.');
      const contact = await Contact.presentPicker();
      if (!contact) return null;
      const name = (await contact.getFullName())?.trim();
      if (!name || name.length > 120)
        throw new Error('The selected contact has no usable name. Enter the person name manually.');
      return { name, source: 'contacts' };
    },
    async currentPlace() {
      await foregroundPermission();
      if (!(await Location.hasServicesEnabledAsync()))
        throw new Error(
          'Location services are disabled. Enter a place label or enable them and retry.',
        );
      const fix = await bounded(
        // One explicit place lookup may use GPS; balanced priority can wait only
        // for a network fix on devices without an available network provider.
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
        'A current location was not available in time. Enter a label or retry.',
      );
      const point = coordinate(fix.coords);
      if (!Number.isSafeInteger(fix.timestamp) || fix.timestamp < 0) {
        throw new Error(
          'The current location timestamp could not be confirmed. Enter a place label or retry.',
        );
      }
      const label = await labelAt(point);
      return {
        label,
        coordinate: point,
        source: 'device',
        capturedAtMs: fix.timestamp,
        accuracyMeters:
          typeof fix.coords.accuracy === 'number' &&
          Number.isFinite(fix.coords.accuracy) &&
          fix.coords.accuracy >= 0
            ? fix.coords.accuracy
            : null,
      };
    },
    async placeAt(value) {
      const point = coordinate(value);
      if (Platform.OS === 'android') await foregroundPermission();
      const label = await labelAt(point);
      return {
        label,
        coordinate: point,
        source: 'map',
        capturedAtMs: Date.now(),
        accuracyMeters: null,
      };
    },
  };
}

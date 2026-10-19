import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  StyleSheet,
  Text,
  TurboModuleRegistry,
  View,
  useWindowDimensions,
} from 'react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import type { CameraRef } from '@maplibre/maplibre-react-native';
import { Action, Field, FormError } from './components';
import { useThemedStyles, type ThemeColors } from './theme';
import {
  MAX_PLACE_LABEL_LENGTH,
  confirmedPlace,
  coordinateFromMap,
  createPlaceLookup,
  loadMapRuntime,
  validatePlaceCandidate,
  type Coordinate,
  type PlaceCandidate,
  type PlaceSnapshot,
} from './placeLookup';

export type MapPlacePickerProps = {
  initialLabel: string;
  services: {
    currentPlace(): Promise<PlaceCandidate>;
    placeAt(coordinate: Coordinate): Promise<PlaceCandidate>;
  };
  onConfirm(place: PlaceSnapshot): void;
  onCancel(): void;
  sessionKey: string;
};

// Type imports are erased; runtime loading remains below the Expo Go/native gate.
type NativeMapRuntime = Pick<
  typeof import('@maplibre/maplibre-react-native'),
  'Map' | 'Camera' | 'Marker'
>;
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const OVERVIEW = { center: [102, 4] as [number, number], zoom: 5 };

class MapBoundary extends React.Component<
  { children: React.ReactNode; onFailure(): void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onFailure();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

// A new editor/owner renders a new session immediately, before effect cleanup.
export function MapPlacePicker(props: MapPlacePickerProps) {
  return <PickerSession key={props.sessionKey} {...props} />;
}

function PickerSession({ initialLabel, services, onConfirm, onCancel }: MapPlacePickerProps) {
  const { colors, ui, styles } = useThemedStyles(createStyles);
  const [label, setLabel] = useState(initialLabel);
  const [selected, setSelected] = useState<Coordinate | null>(null);
  const [candidate, setCandidate] = useState<PlaceCandidate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mapKey, setMapKey] = useState(0);
  const [mapPhase, setMapPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [mapMessage, setMapMessage] = useState('');
  const [initialView, setInitialView] = useState(OVERVIEW);
  const mounted = useRef(false);
  const busyRef = useRef(false);
  const lookup = useMemo(() => createPlaceLookup(), []);
  const camera = useRef<CameraRef>(null);
  const cameraPending = useRef<Coordinate | null>(null);
  const mapAttempt = useRef({ key: 0, phase: 'loading' as 'loading' | 'ready' | 'error' });
  const confirmationSent = useRef(false);
  const { height } = useWindowDimensions();
  const [map] = useState(() =>
    loadMapRuntime<NativeMapRuntime>({
      platform: Platform.OS,
      isExpoGo: Constants.executionEnvironment === ExecutionEnvironment.StoreClient,
      getNativeModule: (name) => TurboModuleRegistry.get(name),
      loadRuntime: () => require('@maplibre/maplibre-react-native') as NativeMapRuntime,
    }),
  );

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      lookup.cancel();
    };
  }, [lookup]);
  useEffect(() => {
    if (!map.available) return;
    const key = mapKey;
    const timer = setTimeout(() => {
      if (
        mounted.current &&
        mapAttempt.current.key === key &&
        mapAttempt.current.phase === 'loading'
      ) {
        mapAttempt.current.phase = 'error';
        setMapPhase('error');
        setMapMessage('The map is taking too long to load. Retry, or enter a place name.');
      }
    }, 15000);
    return () => clearTimeout(timer);
  }, [map.available, mapKey]);

  function moveCamera(point: Coordinate) {
    cameraPending.current = point;
    if (mapAttempt.current.phase !== 'ready' || !camera.current) return;
    cameraPending.current = null;
    const key = mapAttempt.current.key;
    try {
      Promise.resolve(
        camera.current.setStop({
          center: [point.longitude, point.latitude],
          zoom: 15,
          duration: 0,
        }),
      ).catch(() => {
        if (mounted.current && mapAttempt.current.key === key)
          setNotice('The place was found. Reopen the map if it could not recenter.');
      });
    } catch {
      if (mounted.current)
        setNotice('The place was found. Reopen the map if it could not recenter.');
    }
  }
  function mapReady(key: number) {
    if (!mounted.current || mapAttempt.current.key !== key || mapAttempt.current.phase === 'error')
      return;
    mapAttempt.current.phase = 'ready';
    setMapPhase('ready');
    if (cameraPending.current) moveCamera(cameraPending.current);
  }
  function mapFailed(key: number) {
    if (!mounted.current || mapAttempt.current.key !== key) return;
    mapAttempt.current.phase = 'error';
    setMapPhase('error');
    setMapMessage('The map could not load. Retry, or enter a place name.');
  }
  function retryMap() {
    const next = mapKey + 1;
    mapAttempt.current = { key: next, phase: 'loading' };
    setInitialView(
      selected ? { center: [selected.longitude, selected.latitude], zoom: 15 } : OVERVIEW,
    );
    setMapPhase('loading');
    setMapMessage('');
    setMapKey(next);
  }
  function cancelLookup() {
    lookup.cancel();
    busyRef.current = false;
    setBusy(false);
  }
  function editLabel(value: string) {
    cancelLookup();
    setCandidate(null);
    setLabel(value);
    setError('');
    setNotice('');
  }
  function selectPoint(value: unknown, key: number) {
    if (!mounted.current || mapAttempt.current.key !== key || mapAttempt.current.phase !== 'ready')
      return;
    try {
      const point = coordinateFromMap(value);
      cancelLookup();
      setSelected(point);
      if (candidate) setLabel('');
      setCandidate(null);
      setError('');
      setNotice('Point selected. Find its place name, or enter your own.');
    } catch {
      setError('That point could not be selected. Tap the map again.');
    }
  }
  async function findPlace(source: 'map' | 'device') {
    if (!mounted.current || busyRef.current || (source === 'map' && !selected)) return;
    const point = source === 'map' ? selected! : undefined;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const result = await lookup.run(() =>
      source === 'map' ? services.placeAt(point!) : services.currentPlace(),
    );
    if (!mounted.current || !lookup.isCurrent(result) || result.status === 'cancelled') return;
    busyRef.current = false;
    setBusy(false);
    if (result.status !== 'success') {
      setError(
        result.status === 'timeout'
          ? 'The lookup timed out. Try again, or enter a place name.'
          : 'The place could not be found. Check location permission and your connection, or enter a name.',
      );
      return;
    }
    try {
      const found = validatePlaceCandidate(result.value, source, point);
      setSelected(found.coordinate);
      setCandidate(found);
      moveCamera(found.coordinate);
      if (found.label) {
        setLabel(found.label);
        setNotice('Check the suggested name before confirming.');
      } else {
        setCandidate(null);
        if (candidate) setLabel('');
        setNotice(
          'A point was found, but no place name was returned. Enter the name you want to keep.',
        );
      }
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'The returned place could not be used. Enter a place name.',
      );
    }
  }
  function confirm() {
    if (!mounted.current || busyRef.current || confirmationSent.current) return;
    try {
      const place = confirmedPlace(label, candidate);
      confirmationSent.current = true;
      lookup.cancel();
      onConfirm(place);
    } catch (failure) {
      confirmationSent.current = false;
      setError(
        failure instanceof Error ? failure.message : 'The place name could not be confirmed.',
      );
    }
  }
  function cancel() {
    if (!mounted.current || confirmationSent.current) return;
    confirmationSent.current = true;
    lookup.cancel();
    onCancel();
  }
  async function openCredit(url: string) {
    try {
      await Linking.openURL(url);
    } catch {
      if (mounted.current) setError('The attribution link could not open.');
    }
  }
  const NativeMap = map.available ? map.runtime.Map : null;
  const NativeCamera = map.available ? map.runtime.Camera : null;
  const NativeMarker = map.available ? map.runtime.Marker : null;
  const canConfirm = !!label.trim() && label.trim().length <= MAX_PLACE_LABEL_LENGTH && !busy;

  return (
    <View style={styles.content}>
      <Text style={ui.body}>
        Choose a point or enter a place name. Only the confirmed name is kept with the transaction.
      </Text>
      {NativeMap && NativeCamera && NativeMarker ? (
        <>
          <View
            style={[styles.mapFrame, { height: Math.max(220, Math.min(320, height * 0.36)) }]}
            testID="place-map-container"
          >
            <MapBoundary key={mapKey} onFailure={() => mapFailed(mapKey)}>
              <NativeMap
                style={styles.map}
                mapStyle={STYLE_URL}
                attribution
                attributionPosition={{ bottom: 8, right: 8 }}
                onPress={(event) => selectPoint(event.nativeEvent.lngLat, mapKey)}
                onDidFinishRenderingMapFully={() => mapReady(mapKey)}
                onDidFinishRenderingFrameFully={() => mapReady(mapKey)}
                onDidFailLoadingMap={() => mapFailed(mapKey)}
              >
                <NativeCamera ref={camera} initialViewState={initialView} />
                {selected ? (
                  <NativeMarker lngLat={[selected.longitude, selected.latitude]}>
                    <View style={styles.pin} />
                  </NativeMarker>
                ) : null}
              </NativeMap>
            </MapBoundary>
            {mapPhase === 'loading' ? (
              <View pointerEvents="none" style={styles.mapLoading}>
                <ActivityIndicator color={colors.purple} />
                <Text style={ui.body} accessibilityLiveRegion="polite">
                  Loading map…
                </Text>
              </View>
            ) : null}
          </View>
          {mapPhase === 'error' ? (
            <>
              <FormError message={mapMessage} testID="place-map-error" />
              <Action label="Retry map" secondary onPress={retryMap} testID="retry-place-map" />
            </>
          ) : null}
          <View style={styles.credits}>
            <Text
              style={styles.credit}
              accessibilityRole="link"
              onPress={() => {
                void openCredit('https://openmaptiles.org/');
              }}
            >
              © OpenMapTiles
            </Text>
            <Text
              style={styles.credit}
              accessibilityRole="link"
              onPress={() => {
                void openCredit('https://www.openstreetmap.org/copyright');
              }}
            >
              © OpenStreetMap contributors
            </Text>
          </View>
        </>
      ) : (
        <Text selectable style={ui.body} testID="place-map-unavailable">
          {!map.available ? map.message : 'The map is unavailable.'}
        </Text>
      )}
      {selected ? (
        <Text selectable style={[ui.hint, ui.number]} testID="selected-place-coordinate">
          Selected point: {selected.latitude.toFixed(5)}, {selected.longitude.toFixed(5)}
        </Text>
      ) : null}
      <Action
        label="Use my current location"
        secondary
        disabled={busy}
        onPress={() => {
          void findPlace('device');
        }}
        testID="use-current-place"
      />
      <Action
        label="Find name for selected point"
        secondary
        disabled={busy || !selected}
        onPress={() => {
          void findPlace('map');
        }}
        testID="lookup-map-place"
      />
      {busy ? (
        <View style={styles.lookupBusy}>
          <ActivityIndicator color={colors.purple} />
          <Text style={ui.body} accessibilityLiveRegion="polite">
            Finding place…
          </Text>
          <Action
            label="Cancel lookup"
            secondary
            onPress={cancelLookup}
            testID="cancel-place-lookup"
          />
        </View>
      ) : null}
      <Field
        label="Place name"
        multiline
        style={{ minHeight: 112, textAlignVertical: 'top' }}
        value={label}
        onChangeText={editLabel}
        maxLength={MAX_PLACE_LABEL_LENGTH}
        autoCapitalize="words"
        autoCorrect={false}
        hint={
          candidate?.label === label.trim()
            ? 'Suggested by location lookup. You can edit it.'
            : 'Entered by you. A map lookup is optional.'
        }
        testID="place-name-input"
      />
      {notice ? (
        <Text selectable style={ui.hint} accessibilityLiveRegion="polite" testID="place-notice">
          {notice}
        </Text>
      ) : null}
      <FormError message={error} testID="place-picker-error" />
      <Action
        label="Use this place name"
        disabled={!canConfirm}
        onPress={confirm}
        testID="confirm-place-name"
      />
      <Action label="Back to transaction" secondary onPress={cancel} testID="cancel-place-picker" />
    </View>
  );
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { gap: 12, paddingTop: 12 },
  mapFrame: { width: '100%', backgroundColor: colors.raised, borderRadius: 12, overflow: 'hidden' },
  map: { flex: 1 },
  mapLoading: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.raised,
  },
  pin: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.accentFill,
    borderColor: colors.onAccent,
    borderWidth: 3,
  },
  lookupBusy: { gap: 8, alignItems: 'stretch' },
  credits: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  credit: {
    color: colors.purple,
    fontSize: 12,
    lineHeight: 20,
    textDecorationLine: 'underline',
    paddingVertical: 12,
    minHeight: 48,
  },
});

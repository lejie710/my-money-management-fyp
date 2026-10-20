import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { Ledger, localDate } from '../core/model';
import { Action, FormError } from './components';
import { ForecastSheet } from './ForecastSheet';
import { useTheme } from './theme';
import type { ForecastTransportBinding } from '../forecast/client';

export type ForecastEntryProps = {
  ledger: Ledger;
  /** The complete scope + actor + wallet-incarnation token, never just wallet.id. */
  ownerKey: string;
  getToday?: () => string;
  transportBinding?: ForecastTransportBinding | null;
};

export function ForecastEntry(props: ForecastEntryProps) {
  return <ForecastEntryContent key={props.ownerKey} {...props} />;
}

export function ForecastEntryContent({
  ledger,
  ownerKey,
  transportBinding,
  getToday = localDate,
}: ForecastEntryProps) {
  const { colors, ui } = useTheme();
  const [asOfDate, setAsOfDate] = useState<string | null>(null);
  const [error, setError] = useState('');
  const open = () => {
    try {
      setAsOfDate(getToday());
      setError('');
    } catch {
      setError('The current date is unavailable. Reopen this view when the device date is ready.');
    }
  };
  return (
    <View style={[ui.card, ui.gap]}>
      <Text style={ui.heading} accessibilityRole="header">
        Recorded-expense forecast
      </Text>
      <Text style={[ui.body, ui.smallGap]}>
        Explore six future months from complete months of expenses recorded in this wallet. Select
        an as-of date and an expense category inside the forecast.
      </Text>
      <View style={ui.smallGap}>
        <Action label="Open expense forecast" onPress={open} testID="open-expense-forecast" />
      </View>
      <FormError message={error} testID="forecast-open-error" />
      {asOfDate !== null ? (
        <ForecastSheet
          ledger={ledger}
          ownerKey={ownerKey}
          transportBinding={transportBinding}
          initialAsOfDate={asOfDate}
          onClose={() => setAsOfDate(null)}
        />
      ) : null}
    </View>
  );
}

import React from 'react';
import type QRCode from 'react-native-qrcode-svg';
import type { QrRenderProps } from './exportTypes';

/** Loaded only when the user explicitly reveals a QR panel; its error boundary owns failure UI. */
export function NativeTransactionQr(props: QrRenderProps) {
  const { default: QrCode } = require('react-native-qrcode-svg') as { default: typeof QRCode };
  return <QrCode {...props} testID="transaction-qr-svg" />;
}

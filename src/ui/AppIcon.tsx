import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { colors } from './theme';

export type IconName =
  | 'activity'
  | 'plan'
  | 'reports'
  | 'wallet'
  | 'plus'
  | 'receipt'
  | 'category'
  | 'trophy'
  | 'bell'
  | 'calculator'
  | 'user'
  | 'chevron'
  | 'close'
  | 'check'
  | 'arrowup'
  | 'arrowdown';

const outlines: Record<IconName, string> = {
  activity: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  plan: 'M7 3v4M17 3v4M4 10h16M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM8 15l3 3 5-5',
  reports: 'M4 4v16h16M8 15v-4M12 15V7M16 15v-6',
  wallet:
    'M19 8V6a2 2 0 0 0-2-2H6a3 3 0 0 0 0 6h13a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a3 3 0 0 1-3-3V7M21 13h-5v4h5M17.5 15h.01',
  plus: 'M12 5v14M5 12h14',
  receipt: 'M5 3l2 1 2-1 3 1 3-1 2 1 2-1v18l-2-1-2 1-3-1-3 1-2-1-2 1V3ZM8 8h8M8 12h8M8 16h4',
  category: 'M4 4h6v6H4ZM14 4h6v6h-6ZM4 14h6v6H4ZM14 14h6v6h-6Z',
  trophy:
    'M8 4h8v6a4 4 0 0 1-8 0V4ZM8 6H4v2a4 4 0 0 0 4 4M16 6h4v2a4 4 0 0 1-4 4M12 14v5M8 21h8M9 19h6',
  bell: 'M18 9a6 6 0 0 0-12 0v5l-2 3h16l-2-3V9ZM10 21h4M12 3V2',
  calculator:
    'M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM8 6h8v3H8ZM8 13h1M13 13h3M8 17h1M13 17h3',
  user: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2',
  chevron: 'm9 5 7 7-7 7',
  close: 'm6 6 12 12M18 6 6 18',
  check: 'm5 12 4 4L19 6',
  arrowup: 'M12 20V4m-6 6 6-6 6 6',
  arrowdown: 'M12 4v16m-6-6 6 6 6-6',
};

/** Decorative outline; the enclosing control supplies its accessible name. */
export function AppIcon({
  name,
  size = 22,
  color = colors.accent,
  strokeWidth = 1.8,
  testID,
}: {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
  testID?: string;
}) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      testID={testID}
    >
      <Path
        d={outlines[name]}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

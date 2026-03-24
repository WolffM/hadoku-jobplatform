import React from 'react'
import {
  SunIcon,
  MoonIcon,
  CoffeeIcon,
  LeafIcon,
  FlowerIcon,
  StrawberryIcon,
  WaveIcon,
  ZapIcon,
  HeartIcon,
  type ThemeFamily
} from '@wolffm/task-ui-components'

export const BASE_THEME_FAMILIES: ThemeFamily[] = [
  {
    lightIcon: <SunIcon />,
    darkIcon: <MoonIcon />,
    lightTheme: 'light',
    darkTheme: 'dark',
    lightLabel: 'Light',
    darkLabel: 'Dark'
  },
  {
    lightIcon: <CoffeeIcon />,
    darkIcon: <CoffeeIcon />,
    lightTheme: 'coffee-light',
    darkTheme: 'coffee-dark',
    lightLabel: 'Coffee Light',
    darkLabel: 'Coffee Dark'
  },
  {
    lightIcon: <LeafIcon />,
    darkIcon: <LeafIcon />,
    lightTheme: 'nature-light',
    darkTheme: 'nature-dark',
    lightLabel: 'Nature Light',
    darkLabel: 'Nature Dark'
  },
  {
    lightIcon: <FlowerIcon />,
    darkIcon: <FlowerIcon />,
    lightTheme: 'lavender-light',
    darkTheme: 'lavender-dark',
    lightLabel: 'Lavender Light',
    darkLabel: 'Lavender Dark'
  },
  {
    lightIcon: <StrawberryIcon />,
    darkIcon: <StrawberryIcon />,
    lightTheme: 'strawberry-light',
    darkTheme: 'strawberry-dark',
    lightLabel: 'Strawberry Light',
    darkLabel: 'Strawberry Dark'
  },
  {
    lightIcon: <WaveIcon />,
    darkIcon: <WaveIcon />,
    lightTheme: 'ocean-light',
    darkTheme: 'ocean-dark',
    lightLabel: 'Ocean Light',
    darkLabel: 'Ocean Dark'
  }
]

export const EXPERIMENTAL_THEME_FAMILIES: ThemeFamily[] = [
  {
    lightIcon: <ZapIcon />,
    darkIcon: <ZapIcon />,
    lightTheme: 'cyberpunk-light',
    darkTheme: 'cyberpunk-dark',
    lightLabel: 'Cyberpunk Light',
    darkLabel: 'Cyberpunk Dark'
  },
  {
    lightIcon: <HeartIcon />,
    darkIcon: <HeartIcon />,
    lightTheme: 'pink-light',
    darkTheme: 'pink-dark',
    lightLabel: 'Pink Light',
    darkLabel: 'Pink Dark'
  }
]

export function getThemeFamilies(experimentalEnabled: boolean): ThemeFamily[] {
  return experimentalEnabled
    ? [...BASE_THEME_FAMILIES, ...EXPERIMENTAL_THEME_FAMILIES]
    : BASE_THEME_FAMILIES
}

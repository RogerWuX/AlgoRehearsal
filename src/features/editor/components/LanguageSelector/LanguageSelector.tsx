import { Text } from 'react-native';
import type { LanguageSelectorProps } from './LanguageSelector.types';

export default function LanguageSelector({ value }: LanguageSelectorProps) {
  return <Text>{value}</Text>;
}

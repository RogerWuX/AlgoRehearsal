import { StyleSheet, View } from 'react-native';

export default function MicrophoneIcon({ enabled }: { enabled: boolean }) {
  const color = enabled ? '#fff' : '#64748b';
  return <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.icon}>
    <View style={[styles.capsule, { backgroundColor: color }]} />
    <View style={[styles.pickup, { borderColor: color }]} />
    <View style={[styles.stem, { backgroundColor: color }]} />
    <View style={[styles.base, { backgroundColor: color }]} />
    {!enabled && <View style={[styles.slash, { backgroundColor: color }]} />}
  </View>;
}

const styles = StyleSheet.create({
  icon: { width: 24, height: 24 },
  capsule: { position: 'absolute', top: 1, left: 8, width: 8, height: 13, borderRadius: 4 },
  pickup: { position: 'absolute', top: 8, left: 4, width: 16, height: 11, borderWidth: 2, borderTopWidth: 0,
    borderBottomLeftRadius: 8, borderBottomRightRadius: 8 },
  stem: { position: 'absolute', top: 19, left: 11, width: 2, height: 4 },
  base: { position: 'absolute', top: 22, left: 7, width: 10, height: 2, borderRadius: 1 },
  slash: { position: 'absolute', top: 11, left: -2, width: 28, height: 2, borderRadius: 1, transform: [{ rotate: '45deg' }] },
});

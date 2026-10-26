// Expo's declarations import source files that use these JavaScript modules.
// Keep their APIs typed without changing node_modules or weakening strict checks.
declare module 'invariant' {
  function invariant(condition: unknown, message?: string, ...args: unknown[]): asserts condition;
  export = invariant;
}

declare module '@react-native/assets-registry/registry' {
  // Matches the Flow type in @react-native/assets-registry/registry.js.
  export type PackagerAsset = {
    readonly __packager_asset: boolean;
    readonly fileSystemLocation: string;
    readonly httpServerLocation: string;
    readonly width: number | null | undefined;
    readonly height: number | null | undefined;
    readonly scales: number[];
    readonly hash: string;
    readonly name: string;
    readonly type: string;
    readonly resolver?: 'android' | 'generic';
  };

  export function registerAsset(asset: PackagerAsset): number;
  // Expo also accepts virtual assets; see expo-asset's react-native-assets.d.ts.
  export function getAssetByID(
    assetId: number | { uri: string; width: number; height: number }
  ): PackagerAsset | undefined;
}

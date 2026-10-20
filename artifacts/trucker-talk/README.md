# Trucker Talk Android setup

The Capacitor Android project uses the Vite production output in `dist/public`.

1. Add the Android platform once:

   ```sh
   pnpm --filter @workspace/trucker-talk run cap:add:android
   ```

2. Build and sync the web app, providing the deployed WebSocket endpoint:

   ```sh
   VITE_WS_URL=wss://your-host/ws pnpm --filter @workspace/trucker-talk run cap:sync
   ```

`VITE_WS_URL` must be the full secure WebSocket URL ending in `/ws`. It is embedded into the native web bundle at build time. The ordinary browser preview continues to use its same-origin `/ws` endpoint.

After syncing, open the generated `artifacts/trucker-talk/android` project in Android Studio to build or sign an APK/AAB. The configured application ID is `com.truckertalk.app`; replace it with an identifier under your own domain before publishing.

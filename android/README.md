# Voice Trigger

One press on any earphones opens Claude or Gemini voice. Your default assistant does not change, so "Hey Google" keeps working.

## How it works

**Hearing the button.** Android sends a media key to the app that started audio last. The system API that
watches all media keys is closed to normal apps. So, while earphones are connected and a button is set,
`EarbudListener` holds a media session and plays a loop of silence. When another app starts audio, the listener starts its
silence again to get the keys back. A press you mapped starts an assistant. Every other press goes on to the real music
app. During a call, the listener steps aside.

**Opening voice.** Claude has no public way for another app to start voice mode. The app hosts Claude's own home-screen widget, like a
launcher does, and presses its voice button. That runs Claude's own action, the same as a finger tap on the widget. Android asks you to allow the widget first.

## Permissions

| Permission | Why |
| --- | --- |
| Notification access | Android keeps such a service running, and only such a service can control other apps' music. The app does not read notifications |
| Display over other apps | Android blocks a background app from opening a screen without it |
| Widget access | To host the assistant's widget |

The app has no internet permission. The voice trigger activity is not exported, so other apps cannot use this app to start the microphone.

## Limits

- **The phone must unlock first.** On a locked phone, a press asks for the unlock, then opens voice.
- **The silence keeps the Bluetooth audio link open** while earphones are connected and a button is set. Earphones can use a little more battery, and they cannot go to sleep on their own. Clear the buttons to stop this.
- **The widget can change.** The app finds the voice button by its words, in English ("voice"). An app update or another phone language can break this. The app then shows "voice button not found" and logs the widget's views under the tag `VoiceTrigger`.
- **Some players may ignore the forwarded keys.** The app uses the player's normal media controls.
- The earphones' assistant gesture cannot be caught, as the main README says.

## Build

You need JDK 21 and the Android SDK.

```bash
./gradlew testDebugUnitTest assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

A debug build claims the keys without earphones, so you can test with simulated presses:

```bash
adb shell cmd media_session dispatch next
adb logcat -s VoiceTrigger
```

A release build uses the signing key in `keystore.properties` (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`), or else the debug key.

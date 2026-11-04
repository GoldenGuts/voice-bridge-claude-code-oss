package io.github.goldenguts.voicetrigger

import android.content.ComponentName
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioPlaybackConfiguration
import android.media.AudioTrack
import android.media.session.MediaController
import android.media.session.MediaSession
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.os.Handler
import android.os.Looper
import android.service.notification.NotificationListenerService
import android.util.Log
import android.view.KeyEvent

/**
 * Hears the buttons of any earphones. Android sends a media key to the app that played audio last,
 * so while earphones are connected this app holds a media session and plays silence. A mapped press
 * starts an assistant; every other press goes on to the real music app.
 *
 * It is a notification listener for two reasons: Android keeps such a service running, and only such
 * a service may control other apps' media sessions. It does not read the notifications.
 */
class EarbudListener : NotificationListenerService() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var audio: AudioManager
    private var session: MediaSession? = null
    private var track: AudioTrack? = null
    private var detector: PressDetector? = null
    private var claimed = false
    private var others = 0
    private var restarting = false
    private var reclaim: Runnable? = null
    private var steppedAside = false
    private var learner: ((Gesture) -> Unit)? = null

    override fun onListenerConnected() {
        audio = getSystemService(AudioManager::class.java)
        detector = PressDetector(::watched, { ms, run ->
            main.postDelayed(run, ms)
            PressDetector.Cancel { main.removeCallbacks(run) }
        }, ::onGesture)
        session = MediaSession(this, "VoiceTrigger").apply {
            setCallback(callback, main)
            setPlaybackState(
                PlaybackState.Builder()
                    .setActions(PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS)
                    .setState(PlaybackState.STATE_PLAYING, 0, 0f)
                    .build(),
            )
        }
        track = silence()
        audio.registerAudioDeviceCallback(devices, main)
        audio.registerAudioPlaybackCallback(playback, main)
        audio.addOnModeChangedListener(mainExecutor, modes)
        instance = this
        refresh()
    }

    override fun onListenerDisconnected() = shutDown()

    override fun onDestroy() {
        shutDown()
        super.onDestroy()
    }

    private fun shutDown() {
        if (session == null) return
        instance = null
        main.removeCallbacksAndMessages(null)
        audio.unregisterAudioDeviceCallback(devices)
        audio.unregisterAudioPlaybackCallback(playback)
        audio.removeOnModeChangedListener(modes)
        track?.release()
        track = null
        session?.release()
        session = null
        claimed = false
    }

    /** Claim the keys only when it can matter: a button is set and earphones are connected. */
    fun refresh() {
        val mapped = Target.entries.any { Buttons.get(this, it) != null }
        val want = learner != null || (mapped && headsetConnected())
        session?.isActive = want
        val play = want && audio.mode == AudioManager.MODE_NORMAL
        if (play != claimed) {
            claimed = play
            if (play) track?.play() else track?.pause()
            Log.d(AssistantWidget.TAG, "claim keys: $play")
        }
    }

    // A debug build also claims without earphones, so `adb shell cmd media_session dispatch` can test it.
    private fun headsetConnected() =
        applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0 ||
            audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any { it.type in HEADSETS }

    /** A loop of silence. Android ranks media sessions by who started audio last. */
    private fun silence(): AudioTrack {
        val frames = 8000
        return AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
            .setAudioFormat(AudioFormat.Builder().setSampleRate(frames).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
            .setTransferMode(AudioTrack.MODE_STATIC)
            .setBufferSizeInBytes(frames * 2)
            .build()
            .apply {
                write(ShortArray(frames), 0, frames)
                setLoopPoints(0, frames, -1)
            }
    }

    /** Another app started audio, so it now gets the keys. Start our silence again to get them back. */
    private val playback = object : AudioManager.AudioPlaybackCallback() {
        override fun onPlaybackConfigChanged(configs: MutableList<AudioPlaybackConfiguration>) {
            if (restarting) return
            val now = configs.size - if (claimed) 1 else 0
            if (now > others && claimed) restart()
            others = now
        }
    }

    private fun restart() {
        restarting = true
        main.postDelayed({ track?.pause() }, RECLAIM_DELAY_MS)
        main.postDelayed({
            if (claimed) track?.play()
        }, RECLAIM_DELAY_MS + GAP_MS)
        main.postDelayed({
            others = audio.activePlaybackConfigurations.size - if (claimed) 1 else 0
            restarting = false
        }, RECLAIM_DELAY_MS + GAP_MS + SETTLE_MS)
    }

    private val devices = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) = refresh()
        override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) = refresh()
    }

    // During a call or voice chat the silence must not hold the media route.
    private val modes = AudioManager.OnModeChangedListener { refresh() }

    private val callback = object : MediaSession.Callback() {
        override fun onMediaButtonEvent(intent: Intent): Boolean {
            if (steppedAside) return true // our own forwarded key came back: no other player took it
            val e = intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java) ?: return false
            if (e.repeatCount > 0) return true
            when (e.action) {
                KeyEvent.ACTION_DOWN -> detector?.down(e.keyCode)
                KeyEvent.ACTION_UP -> detector?.up(e.keyCode)
            }
            return true
        }

        // Some Bluetooth stacks call these instead of sending a key.
        override fun onPlay() = press(KeyEvent.KEYCODE_MEDIA_PLAY)
        override fun onPause() = press(KeyEvent.KEYCODE_MEDIA_PAUSE)
        override fun onSkipToNext() = press(KeyEvent.KEYCODE_MEDIA_NEXT)
        override fun onSkipToPrevious() = press(KeyEvent.KEYCODE_MEDIA_PREVIOUS)

        private fun press(key: Int) {
            if (steppedAside) return
            detector?.down(key)
            detector?.up(key)
        }
    }

    private fun watched(key: Int): Set<Kind> {
        if (learner != null) return Kind.entries.toSet()
        return Target.entries.mapNotNull { Buttons.get(this, it) }.filter { it.key == key }.map { it.kind }.toSet()
    }

    private fun onGesture(g: Gesture) {
        Log.d(AssistantWidget.TAG, "gesture $g")
        learner?.let {
            learner = null
            it(g)
            refresh()
            return
        }
        val target = Target.entries.firstOrNull { Buttons.get(this, it) == g }
        if (target != null) TriggerActivity.start(this, target) else forward(g.key)
    }

    /** Learn the next gesture from the earphones. */
    fun learn(onDone: (Gesture) -> Unit) {
        learner = onDone
        refresh()
    }

    fun cancelLearn() {
        learner = null
        refresh()
    }

    /** Give a press to the real music app. */
    private fun forward(key: Int) {
        val c = musicApp() ?: return wakeLastPlayer(key)
        val playing = c.playbackState?.state == PlaybackState.STATE_PLAYING
        val controls = c.transportControls
        when (key) {
            KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_HEADSETHOOK ->
                if (playing) controls.pause() else controls.play()
            KeyEvent.KEYCODE_MEDIA_NEXT -> controls.skipToNext()
            KeyEvent.KEYCODE_MEDIA_PREVIOUS -> controls.skipToPrevious()
            else -> {
                c.dispatchMediaButtonEvent(KeyEvent(KeyEvent.ACTION_DOWN, key))
                c.dispatchMediaButtonEvent(KeyEvent(KeyEvent.ACTION_UP, key))
            }
        }
    }

    private fun musicApp(): MediaController? {
        val all = getSystemService(MediaSessionManager::class.java)
            .getActiveSessions(ComponentName(this, EarbudListener::class.java))
            .filter { it.packageName != packageName }
        return all.firstOrNull { it.playbackState?.state == PlaybackState.STATE_PLAYING } ?: all.firstOrNull()
    }

    /** No music app is open. Step aside, so Android gives the key to the app that played last. */
    private fun wakeLastPlayer(key: Int) {
        steppedAside = true
        session?.isActive = false
        track?.pause()
        claimed = false
        audio.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, key))
        audio.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP, key))
        reclaim?.let(main::removeCallbacks)
        reclaim = Runnable {
            steppedAside = false
            refresh()
        }.also { main.postDelayed(it, WAKE_MS) }
    }

    companion object {
        /** The running service, when notification access is on. */
        var instance: EarbudListener? = null
            private set

        private const val RECLAIM_DELAY_MS = 500L
        private const val GAP_MS = 300L
        private const val SETTLE_MS = 500L
        private const val WAKE_MS = 1500L

        private val HEADSETS = setOf(
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
            AudioDeviceInfo.TYPE_BLE_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
            AudioDeviceInfo.TYPE_USB_HEADSET,
            AudioDeviceInfo.TYPE_HEARING_AID,
        )
    }
}

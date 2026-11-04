package io.github.goldenguts.voicetrigger

import android.content.Context
import android.view.KeyEvent

/** Which earbud gesture starts which assistant. Saved on the phone only. */
object Buttons {
    private fun prefs(c: Context) = c.getSharedPreferences("buttons", Context.MODE_PRIVATE)

    fun get(c: Context, t: Target): Gesture? {
        val p = prefs(c)
        val key = p.getInt("${t.name}_key", -1)
        val kind = p.getString("${t.name}_kind", null)
        return if (key < 0 || kind == null) null else Gesture(key, Kind.valueOf(kind))
    }

    fun set(c: Context, t: Target, g: Gesture?) {
        prefs(c).edit().apply {
            if (g == null) {
                remove("${t.name}_key")
                remove("${t.name}_kind")
            } else {
                putInt("${t.name}_key", g.key)
                putString("${t.name}_kind", g.kind.name)
            }
        }.apply()
    }

    fun label(g: Gesture): String {
        val key = when (g.key) {
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE, KeyEvent.KEYCODE_HEADSETHOOK -> "Play/pause"
            KeyEvent.KEYCODE_MEDIA_NEXT -> "Next track"
            KeyEvent.KEYCODE_MEDIA_PREVIOUS -> "Previous track"
            else -> KeyEvent.keyCodeToString(g.key).removePrefix("KEYCODE_")
        }
        val how = when (g.kind) {
            Kind.ONE -> "one press"
            Kind.TWO -> "two presses"
            Kind.HOLD -> "hold"
        }
        return "$key, $how"
    }
}

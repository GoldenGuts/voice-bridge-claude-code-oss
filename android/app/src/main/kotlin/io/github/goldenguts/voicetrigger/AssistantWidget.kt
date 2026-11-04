package io.github.goldenguts.voicetrigger

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import android.util.SizeF
import android.view.View
import android.view.ViewGroup
import android.widget.TextView

/** An assistant whose home-screen widget we host: its provider and the words on its voice button. */
enum class Target(val label: String, val provider: ComponentName, val want: List<String>, val avoid: List<String>) {
    CLAUDE(
        "Claude",
        ComponentName("com.anthropic.claude", "com.anthropic.claude.widget.ClaudeAppWidgetReceiver"),
        listOf("voice"),
        listOf("dictat"),
    ),
    GEMINI(
        "Gemini",
        ComponentName("com.google.android.apps.bard", "com.google.android.apps.bard.widget.RobinToolBarAppWidgetReceiver"),
        listOf("talk", "live", "voice", "mic"),
        listOf("camera", "video", "share", "type", "keyboard"),
    );

    fun installed(c: Context): Boolean = try {
        c.packageManager.getPackageInfo(provider.packageName, 0)
        true
    } catch (_: PackageManager.NameNotFoundException) {
        false
    }
}

/**
 * Hosts an assistant's own widget (like a launcher does) so its voice button can be pressed from code.
 * The press runs the assistant's own PendingIntent, the same as a finger tap on the widget.
 */
object AssistantWidget {
    const val TAG = "VoiceTrigger"
    const val HOST_ID = 7301

    private fun prefs(c: Context) = c.getSharedPreferences("widgets", Context.MODE_PRIVATE)

    fun savedId(c: Context, t: Target): Int = prefs(c).getInt(t.name, AppWidgetManager.INVALID_APPWIDGET_ID)

    fun save(c: Context, t: Target, id: Int) = prefs(c).edit().putInt(t.name, id).apply()

    /** The widget is still bound to us and still that assistant's. */
    fun isReady(c: Context, t: Target): Boolean {
        val id = savedId(c, t)
        if (id == AppWidgetManager.INVALID_APPWIDGET_ID) return false
        return AppWidgetManager.getInstance(c).getAppWidgetInfo(id)?.provider == t.provider
    }

    /** A 2x2 size, the one that shows the voice button. */
    fun sizeOptions(): Bundle = Bundle().apply {
        putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 180)
        putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 180)
        putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, 180)
        putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 180)
        putParcelableArrayList(AppWidgetManager.OPTION_APPWIDGET_SIZES, arrayListOf(SizeF(180f, 180f)))
    }

    /** The voice button: a clickable view whose label has one of the target's words (and none to avoid). */
    fun findVoiceButton(root: View, t: Target): View? {
        val all = mutableListOf<View>()
        fun walk(v: View) {
            all += v
            if (v is ViewGroup) for (i in 0 until v.childCount) walk(v.getChildAt(i))
        }
        walk(root)
        fun label(v: View): String {
            val own = listOfNotNull(v.contentDescription, (v as? TextView)?.text).joinToString(" ")
            val kids = if (v is ViewGroup) (0 until v.childCount).joinToString(" ") { label(v.getChildAt(it)) } else ""
            return "$own $kids".lowercase()
        }
        val clickable = all.filter { it.isClickable }
        for (word in t.want) {
            clickable.firstOrNull { v -> label(v).let { it.contains(word) && t.avoid.none(it::contains) } }?.let { return it }
        }
        return null
    }

    /** Logs the widget's views, to fix findVoiceButton when an app update changes its widget. */
    fun dump(root: View, depth: Int = 0) {
        Log.d(TAG, "${"  ".repeat(depth)}${root.javaClass.simpleName} click=${root.isClickable} desc=${root.contentDescription} text=${(root as? TextView)?.text}")
        if (root is ViewGroup) for (i in 0 until root.childCount) dump(root.getChildAt(i), depth + 1)
    }
}

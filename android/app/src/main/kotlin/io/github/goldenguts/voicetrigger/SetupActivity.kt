package io.github.goldenguts.voicetrigger

import android.app.Activity
import android.appwidget.AppWidgetHost
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProviderInfo
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** One screen with every setup step and its state. */
class SetupActivity : Activity() {
    private lateinit var list: LinearLayout
    private lateinit var host: AppWidgetHost
    private var pendingId = AppWidgetManager.INVALID_APPWIDGET_ID
    private var pendingTarget = Target.CLAUDE
    private var learning: Target? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        host = AppWidgetHost(this, AssistantWidget.HOST_ID)
        list = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad * 2, pad, pad * 2)
        }
        setContentView(ScrollView(this).apply { addView(list) })
    }

    override fun onResume() {
        super.onResume()
        draw()
    }

    override fun onPause() {
        if (learning != null) {
            learning = null
            EarbudListener.instance?.cancelLearn()
        }
        super.onPause()
    }

    private val pad get() = (16 * resources.displayMetrics.density).toInt()

    private fun draw() {
        list.removeAllViews()
        title("Voice Trigger")
        text("Start voice chat with one press on your earphones.")

        val listening = EarbudListener.instance != null
        title(if (listening) "1. Hear the buttons: on" else "1. Hear the buttons: off")
        text("Turn on notification access. The app needs it to hear the buttons and to control your music. It does not read your notifications, and it has no internet permission.\n\nIf Android says \"Restricted setting\", open App info, tap the top-right menu, and choose \"Allow restricted settings\". Then try again.")
        if (!listening) {
            button("Notification access") { startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) }
            button("App info") { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) }
        }

        val overlay = Settings.canDrawOverlays(this)
        title(if (overlay) "2. Open over other apps: on" else "2. Open over other apps: off")
        text("Android needs this to start the voice screen while another app is open.")
        if (!overlay) button("Allow") { startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName"))) }

        Target.entries.forEachIndexed { i, t -> assistant(i + 3, t, listening) }
    }

    private fun assistant(step: Int, t: Target, listening: Boolean) {
        title("$step. ${t.label}")
        if (!t.installed(this)) return text("${t.label} is not installed. This step is optional if you do not use it.")
        if (!AssistantWidget.isReady(this, t)) {
            text("Allow this app to use the ${t.label} widget.")
            return button("Connect ${t.label}") { bind(t) }
        }
        val g = Buttons.get(this, t)
        text(
            when {
                learning == t -> "Now press the button on your earphones, the way you want to use it."
                g != null -> "Button: ${Buttons.label(g)}"
                else -> "Button: not set"
            },
        )
        if (learning == null) {
            button(if (g == null) "Set earphone button" else "Change earphone button") {
                val service = EarbudListener.instance
                if (service == null || !listening) return@button text("Do step 1 first.")
                learning = t
                service.learn { got ->
                    learning = null
                    // One gesture starts one assistant.
                    Target.entries.filter { it != t && Buttons.get(this, it) == got }.forEach { Buttons.set(this, it, null) }
                    Buttons.set(this, t, got)
                    service.refresh()
                    draw()
                }
                draw()
            }
            if (g != null) button("Clear button") {
                Buttons.set(this, t, null)
                EarbudListener.instance?.refresh()
                draw()
            }
            button("Test: start ${t.label} voice") { TriggerActivity.start(this, t) }
        }
    }

    private fun bind(t: Target) {
        pendingTarget = t
        pendingId = host.allocateAppWidgetId()
        if (AppWidgetManager.getInstance(this).bindAppWidgetIdIfAllowed(pendingId, t.provider, AssistantWidget.sizeOptions())) {
            afterBind()
        } else {
            startActivityForResult(
                Intent(AppWidgetManager.ACTION_APPWIDGET_BIND).apply {
                    putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, pendingId)
                    putExtra(AppWidgetManager.EXTRA_APPWIDGET_PROVIDER, t.provider)
                    putExtra(AppWidgetManager.EXTRA_APPWIDGET_OPTIONS, AssistantWidget.sizeOptions())
                },
                REQ_BIND,
            )
        }
    }

    private fun afterBind() {
        val info = AppWidgetManager.getInstance(this).getAppWidgetInfo(pendingId)
        val needsConfig = info?.configure != null &&
            (info.widgetFeatures and AppWidgetProviderInfo.WIDGET_FEATURE_CONFIGURATION_OPTIONAL) == 0
        if (needsConfig) {
            host.startAppWidgetConfigureActivityForResult(this, pendingId, 0, REQ_CONFIG, null)
        } else {
            done()
        }
    }

    private fun done() {
        AssistantWidget.save(this, pendingTarget, pendingId)
        draw()
    }

    @Deprecated("Activity result API is fine here")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        when {
            resultCode != RESULT_OK -> host.deleteAppWidgetId(pendingId)
            requestCode == REQ_BIND -> afterBind()
            requestCode == REQ_CONFIG -> done()
        }
    }

    private fun title(s: String) = add(TextView(this).apply {
        text = s
        textSize = 20f
        setPadding(0, pad, 0, pad / 2)
    })

    private fun text(s: String) = add(TextView(this).apply {
        text = s
        textSize = 15f
        setPadding(0, 0, 0, pad / 2)
    })

    private fun button(s: String, onClick: () -> Unit) = add(Button(this).apply {
        text = s
        setOnClickListener { onClick() }
    })

    private fun add(v: View) = list.addView(v)

    companion object {
        const val REQ_BIND = 1
        const val REQ_CONFIG = 2
    }
}

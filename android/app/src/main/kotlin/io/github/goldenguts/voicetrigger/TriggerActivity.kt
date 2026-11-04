package io.github.goldenguts.voicetrigger

import android.app.Activity
import android.app.KeyguardManager
import android.appwidget.AppWidgetHost
import android.appwidget.AppWidgetHostView
import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.Toast

/** Invisible screen: shows an assistant's widget off to the side, presses its voice button, and closes. */
class TriggerActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var host: AppWidgetHost
    private lateinit var view: AppWidgetHostView
    private lateinit var target: Target

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        target = Target.valueOf(intent.getStringExtra(EXTRA_TARGET) ?: Target.CLAUDE.name)
        if (!AssistantWidget.isReady(this, target)) {
            startActivity(Intent(this, SetupActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            finish()
            return
        }
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        val id = AssistantWidget.savedId(this, target)
        host = AppWidgetHost(applicationContext, AssistantWidget.HOST_ID)
        host.startListening()
        view = host.createView(applicationContext, id, AppWidgetManager.getInstance(this).getAppWidgetInfo(id))
        val box = FrameLayout(this).apply { alpha = 0f }
        box.addView(view, FrameLayout.LayoutParams(600, 600))
        setContentView(box, ViewGroup.LayoutParams(600, 600))

        val keyguard = getSystemService(KeyguardManager::class.java)
        if (keyguard.isKeyguardLocked) {
            // The assistant opens behind the lock screen, so ask for the unlock first.
            keyguard.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
                override fun onDismissSucceeded() = tryPress(0)
                override fun onDismissCancelled() = finish()
                override fun onDismissError() = finish()
            })
        } else {
            tryPress(0)
        }
    }

    private fun tryPress(attempt: Int) {
        val button = AssistantWidget.findVoiceButton(view, target)
        if (button != null) {
            Log.d(AssistantWidget.TAG, "pressing the $target voice button after ${attempt * 100} ms")
            button.performClick()
            main.postDelayed({ finish() }, 300)
            return
        }
        if (attempt < 30) {
            main.postDelayed({ tryPress(attempt + 1) }, 100)
        } else {
            AssistantWidget.dump(view)
            Toast.makeText(this, "${target.label}: voice button not found", Toast.LENGTH_SHORT).show()
            finish()
        }
    }

    override fun onDestroy() {
        if (::host.isInitialized) host.stopListening()
        super.onDestroy()
    }

    companion object {
        private const val EXTRA_TARGET = "target"

        fun start(c: Context, t: Target) {
            c.startActivity(
                Intent(c, TriggerActivity::class.java)
                    .putExtra(EXTRA_TARGET, t.name)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION),
            )
        }
    }
}
